import { IAllExecuteFunctions, ICredentialDataDecryptedObject } from 'n8n-workflow';
import { Service } from 'typedi';
import { natsConnectionOptions } from './common';
import { connect } from "@nats-io/transport-node";
import { NatsConnection } from '@nats-io/nats-core';
import { jetstream, JetStreamOptions } from '@nats-io/jetstream';
import { createHash } from 'crypto';

type ConnectionEntry = {
	id: string,
	connection: NatsConnection,
	refCount: number,
	timer?: string | number | NodeJS.Timeout,
	hash: string
}

const idleTimeout = 180_000

// const ncPool = {
// 	connections: new Map<string, ConnectionEntry>(),
// }

@Service({ global: true })
export class NatsService {

	private static connections = new Map<string, ConnectionEntry>()
	private static registry = new FinalizationRegistry(NatsService.releaseConnection)
	private static counter = 0;

	constructor() {

	}

	// Debug method to check connection status
	getConnectionStatus(connectionId: string) {
		const entry = NatsService.connections.get(connectionId)
		if (!entry) {
			return { exists: false }
		}

		return {
			exists: true,
			id: entry.id,
			refCount: entry.refCount,
			isClosed: entry.connection.isClosed(),
			isDraining: entry.connection.isDraining(),
			hasTimer: !!entry.timer
		}
	}

	async getConnection(func: IAllExecuteFunctions, credentials?: { id:string, values:ICredentialDataDecryptedObject }): Promise<NatsConnectionHandle> {

		if(!credentials) {
			const values = await func.getCredentials<ICredentialDataDecryptedObject>('natsApi', 0)
			const node = func.getNode()
			const id = node?.credentials?.['natsApi']?.id ?? values?.name as string ?? func.getExecutionId()
			credentials = { id, values }
		}

		const options = natsConnectionOptions(credentials?.values)

		const cid = credentials.id

		//we hash the credential options and us it as the connection pool change detection
		const credHash = createHash('sha256')
			.update(
				Object.entries(options)
					.filter(([, v]) => v !== undefined && v !== '')
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, v]) => `${k}=${v}`)
					.join('|'),
			)
			.digest('hex')

		let entry = NatsService.connections.get(cid)

		if(entry && entry.hash != credHash) {
			//the credentials changed and we need to reconnect
			NatsService.connections.delete(cid)
			entry.connection.close()
			entry = undefined
		}

		if(entry && entry.connection.isClosed()) {
			// Remove the closed connection from cache and create a new one
			NatsService.connections.delete(cid)
			entry = undefined
		}

		if (!entry) {
			const connection = await connect(options)

			// Add connection event listeners for better reconnection handling
			connection.closed().then(() => {
				// Connection has been permanently closed, remove from cache
				NatsService.connections.delete(cid)
			}).catch(() => {
				// Error in connection, remove from cache
				NatsService.connections.delete(cid)
			})

			entry = {
				id: `${cid}-${NatsService.counter++}`, //entry Id
				connection: connection,
				refCount: 1,
				hash: credHash
			}
			NatsService.connections.set(cid, entry)

			//console.debug("nats connected: ", entry.connection.info?.client_id)
		} else if (entry.refCount++ == 0 && entry.timer) {
			clearTimeout(entry.timer)
			entry.timer = undefined
		}

		const token = { id: entry.id }
		const handle = new NatsConnectionHandle(this, entry.connection, token)
		NatsService.registry.register(handle, token.id, token)

		return handle
	}

	async getJetStream(func: IAllExecuteFunctions) {

		const credentials = await func.getCredentials('natsApi', 0)

		const node = func.getNode()
		const credentialId = node?.credentials?.['natsApi']?.id ?? credentials.name as string ?? func.getExecutionId()

		//normalize options
		//nats options expect undefined to use default
		const normaizedOptions = Object.fromEntries(Object.entries(credentials)
			.map(([key, value]) => [key, value === '' ? undefined : value])
		)

		const jsOptions: JetStreamOptions = {
			apiPrefix: normaizedOptions['jsApiPrefix'] as string ?? '$JS.API', //undefined does not work
			timeout: normaizedOptions['jsTimeout'] as number,
			domain: normaizedOptions['jsDomain'] as string,
			watcherPrefix: normaizedOptions['jsWatcherPrefix'] as string,
		}

		const ncHandle = await this.getConnection(func, { id: credentialId, values: credentials});

		const js = jetstream(ncHandle.connection, jsOptions);

		return {
			connection: ncHandle.connection,
			js: js,
			[Symbol.dispose]() { ncHandle[Symbol.dispose]() }
		}
	}

	release(token: Partial<{ id: string }>) {
		NatsService.registry.unregister(token)
		if (token.id) {
			NatsService.releaseConnection(token.id)
		}
	}

	private static releaseConnection(entryId: string) {
		const i = entryId.lastIndexOf('-');
		const cid = entryId.substring(0, i)

		const entry = this.connections.get(cid)
		if(!entry || entry.id != entryId) {
			return
		}

		if(entry.connection.isClosed()) {
			this.connections.delete(cid)
			return
		}

		if (entry.refCount > 0 && --entry.refCount == 0) {
			entry.timer = setTimeout((list, cid, entry) => {
				if (entry.refCount == 0) {
					const current = list.get(cid)
					if(current && current.id == entry.id) {
						list.delete(cid)
					}
					entry.connection.drain()
				}
			}, idleTimeout, this.connections, cid, entry);
		}
	}
}

export class NatsConnectionHandle implements Disposable {

	constructor(private service: NatsService, public connection: NatsConnection, private token: object) {
	}

	[Symbol.dispose]() {
		if (this.service) {
			//todo how can this.service be undefined
			this.service.release(this.token)
			this.token = {}
		}
	}
}

