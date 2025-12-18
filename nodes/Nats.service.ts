import { IAllExecuteFunctions, ICredentialDataDecryptedObject } from 'n8n-workflow';
import { Service } from 'typedi';
import { natsConnectionOptions } from './common';
import { connect } from "@nats-io/transport-node";
import { NatsConnection } from '@nats-io/nats-core';
import { jetstream, JetStreamOptions } from '@nats-io/jetstream';

type ConnectionEntry = {
	id: string,
	connection: NatsConnection,
	refCount: number,
	timer?: string | number | NodeJS.Timeout,
}

const idleTimeout = 180_000

@Service({ global: true })
export class NatsService {

	private connections = new Map<string, ConnectionEntry>()
	private registry = new FinalizationRegistry(this.releaseConnection)
	private counter = 0;

	constructor() {
	}

	// Debug method to check connection status
	getConnectionStatus(connectionId: string) {
		const entry = this.connections.get(connectionId)
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

	async getConnection(func: IAllExecuteFunctions, credentials?: ICredentialDataDecryptedObject): Promise<NatsConnectionHandle> {

		//todo acquire n8n credentials id
		//hack use the connection name as the id
		credentials ??= await func.getCredentials<ICredentialDataDecryptedObject>('natsApi', 0)
		const options = natsConnectionOptions(credentials)
		let cid = options.name ? options.name : func.getExecutionId()

		let entry = this.connections.get(cid)

		if(entry && entry.connection.isClosed()) {
			// Remove the closed connection from cache and create a new one
			this.connections.delete(cid)
			entry = undefined
		}

		if (!entry) {
			const connection = await connect(options)

			// Add connection event listeners for better reconnection handling
			connection.closed().then(() => {
				// Connection has been permanently closed, remove from cache
				this.connections.delete(cid)
			}).catch(() => {
				// Error in connection, remove from cache
				this.connections.delete(cid)
			})

			entry = {
				id: `${cid}-${this.counter++}`, //entry Id
				connection: connection,
				refCount: 1,
			}
			this.connections.set(cid, entry)
		} else if (entry.refCount++ == 0 && entry.timer) {
			clearTimeout(entry.timer)
			entry.timer = undefined
		}

		const token = { id: entry.id }
		const handle = new NatsConnectionHandle(this, entry.connection, token)
		this.registry.register(handle, token.id, token)

		return handle
	}

	async getJetStream(func: IAllExecuteFunctions) {

		const credentials = await func.getCredentials('natsApi', 0)

		const jsOptions: JetStreamOptions = {
			apiPrefix: credentials['jsApiPrefix'] as string,
			timeout: credentials['jsTimeout'] as number,
			domain: credentials['jsDomain'] as string
		}
		if (jsOptions.apiPrefix === '') {
			jsOptions.apiPrefix = undefined
		}
		if (jsOptions.domain === '') {
			jsOptions.domain = undefined
		}

		const nats = await this.getConnection(func, credentials);

		const js = jetstream(nats.connection, jsOptions);

		return {
			connection: nats.connection,
			js: js,
			[Symbol.dispose]() { nats[Symbol.dispose]() }
		}
	}

	release(token: Partial<{ id: string }>) {
		this.registry.unregister(token)
		if (token.id) {
			this.releaseConnection(token.id)
		}
	}

	private releaseConnection(entryId: string) {
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

