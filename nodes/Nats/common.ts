import { IAllExecuteFunctions } from "n8n-workflow";
import { natsConnectionOptions } from "../common";
import { connect } from "@nats-io/transport-node";
import { NatsConnection } from "@nats-io/nats-core";

export const natsConnection = async (func: IAllExecuteFunctions, idx: number): Promise<NatsConnection>  => {
	const credentials =  await func.getCredentials('natsApi', idx)
	const options = natsConnectionOptions(credentials)

	return connect(options)
}

