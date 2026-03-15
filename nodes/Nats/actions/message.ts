import { MsgHdrs } from "@nats-io/nats-core";
import { FunctionsBase, IDataObject, IExecuteFunctions, INodeExecutionData, ITriggerFunctions, NodeOperationError } from "n8n-workflow";

export type NatsNodeHeaders = Record<string,string|string[]|undefined>

export type NatsNodeData = IDataObject|string

export interface NatsNodeMessage {
	subject:string
	reply?:string
	headers:NatsNodeHeaders
	data?:NatsNodeData
}

export interface NatsNodeMessageOptions {
	jsonParseBody?:boolean
	contentIsBinary?:boolean
	onlyContent?:boolean
}

export interface NatsNodeRequestOptions {
	timeout?: number,
	requestMany?: boolean,
	replies?:number
}

export interface INatsMsgLike {
	subject: string
	reply?:string
	data: Uint8Array,
	headers?:MsgHdrs

	json<T>(): T
	string(): string
}

export type NodeMessageFunctions = Pick<FunctionsBase, "getNode"> & (Pick<IExecuteFunctions,"helpers">|Pick<ITriggerFunctions,"helpers">)

export async function createNatsNodeMessage(func:NodeMessageFunctions, msg:INatsMsgLike, idx?: number, options:NatsNodeMessageOptions = {}) {

	const item: INodeExecutionData = {
		json: {},
		pairedItem: idx
	}

	let jsonParse = options.jsonParseBody

	if(jsonParse === undefined && msg.data.length >= 2) {
		jsonParse = msg.data.at(0) === 123 && msg.data.at(-1) === 125
	}

	if (options.contentIsBinary === true) {
		//todo get output binary name
		item.binary = {
			data: await func.helpers.prepareBinaryData(Buffer.from(msg.data)),
		}
	} else if(jsonParse) {
		const data = msg.data.length > 0
			? msg.json<IDataObject>() : {}

		if(options.onlyContent)
			item.json = data
		else
			item.json.data = data

	} else {
		item.json.data = msg.string()
	}

	//copy header values
	const headers:NatsNodeHeaders = {}
	if(msg.headers) {
		for(var[key,values] of msg.headers) {
			headers[key] = values.length == 1 ? values.at(0) : values
		}
	}

	if (!options.onlyContent) {
		//todo option for delivery info

		item.json.subject = msg.subject
		if(msg.reply)
			item.json.reply = msg.reply

		item.json.headers = headers
	}

	if(msg.headers?.hasError) {
		const node = func.getNode()

		const error = new NodeOperationError(node, new Error(msg.headers.status),
			{
				itemIndex: idx,
				message: `Error ${msg.headers.code}`,
				description: msg.headers.description
			})

		if(!node.continueOnFail)
			throw error

		item.error = error
	}

	return item
}
