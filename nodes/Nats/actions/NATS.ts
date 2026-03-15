import { headers, NatsConnection, Payload, RequestManyOptions, RequestOptions } from "@nats-io/nats-core";
import { IDataObject, IExecuteFunctions, INodeExecutionData } from "n8n-workflow";
import { createNatsNodeMessage, type NatsNodeMessageOptions, type NatsNodeRequestOptions } from "./message";

// Re-export all types and functions from message.ts for backward compatibility
export { createNatsNodeMessage } from "./message";
export type { NatsNodeHeaders, NatsNodeData, NatsNodeMessage, NatsNodeMessageOptions, NatsNodeRequestOptions, INatsMsgLike, NodeMessageFunctions } from "./message";

export async function publish(func: IExecuteFunctions, connection: NatsConnection, idx: number, returnData: INodeExecutionData[]): Promise<any> {
	const head = headers()
	for (const header of ((func.getNodeParameter('headersUi', idx) as IDataObject).headerValues ?? []) as IDataObject[]) {
		head.set(header.key as string, header.value as string)
	}
	let subject = func.getNodeParameter('subject', idx) as string
	const options = { headers: head }
	switch (func.getNodeParameter('contentType', idx)) {
		case 'string':
			connection.publish(subject, func.getNodeParameter('payload', idx) as string, options)
			break;
		case 'binaryData':
			const payloadBinaryPropertyName = func.getNodeParameter('payloadBinaryPropertyName', idx)
			connection.publish(subject, new Uint8Array(await func.helpers.getBinaryDataBuffer(idx, payloadBinaryPropertyName as string)), options)
			break;
	}
	returnData.push({
		json: { publish: true },
		pairedItem: idx
	})
}

export async function request(func: IExecuteFunctions, connection: NatsConnection, idx: number, returnData: INodeExecutionData[]): Promise<any> {
	const head = headers()
	for (const header of ((func.getNodeParameter('headersUi', idx) as IDataObject).headerValues ?? []) as IDataObject[]) {
		head.set(header.key as string, header.value as string)
	}
	const subject = func.getNodeParameter('subject', idx) as string

	const options = func.getNodeParameter('options', idx, {}) as IDataObject & NatsNodeMessageOptions & NatsNodeRequestOptions

	let payload:Payload

	switch (func.getNodeParameter('contentType', idx)) {
		case 'string':
			payload = func.getNodeParameter('payload', idx) as string
			break;
		case 'binaryData':
			const payloadBinaryPropertyName = func.getNodeParameter('payloadBinaryPropertyName', idx) as string
			const binary = await func.helpers.getBinaryDataBuffer(idx, payloadBinaryPropertyName)
			payload = new Uint8Array(binary)
			break;
		default:
			throw new Error("unknown content type")
	}

	if(options.requestMany) {
		const reqOpts:Partial<RequestManyOptions> = {
			headers: head,
			//todo implement strategy
			//strategy: RequestStrategy.Timer,
			maxMessages: options.replies,
			maxWait: options.timeout
		}

		const responses = await connection.requestMany(subject, payload, reqOpts)

		for await(const rsp of responses) {
			const	item = await createNatsNodeMessage(func, rsp, idx, options)

			returnData.push(item)
		}
	} else {
		const reqOpts:RequestOptions = {
			headers: head,
			timeout: options.timeout ?? 600
		}

		const rsp = await connection.request(subject, payload, reqOpts)

		const	item = await createNatsNodeMessage(func, rsp, idx, options)

		returnData.push(item)
	}
}
