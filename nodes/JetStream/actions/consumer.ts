import {
	IExecuteResponsePromiseData,
	IRun,
	ITriggerFunctions,
	NodeOperationError,
} from 'n8n-workflow';

import { createNatsNodeMessage, NatsNodeMessageOptions } from '../../Nats/actions/message';

export interface ConsumeContext {
	emit: ITriggerFunctions['emit'];
	emitError: ITriggerFunctions['emitError'];
	helpers: ITriggerFunctions['helpers'];
	getNode: ITriggerFunctions['getNode'];
}

export interface ConsumeOptions extends NatsNodeMessageOptions {
	acknowledge: string;
}

export interface ConsumerMessages {
	[Symbol.asyncIterator](): AsyncIterator<any>;
	close(): Promise<void | Error>;
	status(): AsyncIterable<any>;
}

export async function consumeMessages(
	ctx: ConsumeContext,
	messages: ConsumerMessages,
	options: ConsumeOptions,
): Promise<void> {
	const acknowledgeMode = options.acknowledge;

	for await (const message of messages) {
		message.working();
		if (acknowledgeMode === 'immediately') {
			await message.ackAck();
		}
		try {
			const item = await createNatsNodeMessage(ctx as any, message, undefined, options);

			if (acknowledgeMode === 'executionFinishes' || acknowledgeMode === 'executionFinishesSuccessfully') {

				const responsePromise = await ctx.helpers.createDeferredPromise<IRun>();
				ctx.emit([ctx.helpers.returnJsonArray([item])], undefined, responsePromise);

				//we need to ack or nck the message
				responsePromise.promise
					.then(async run => {
						try {
							if (!run.data.resultData.error || acknowledgeMode === 'executionFinishes') {
								await message.ackAck();
							} else {
								message.nak();
							}
						} catch(ackError) {
							//maybe not proper handling
							ctx.emit([ctx.helpers.returnJsonArray({
								error: new NodeOperationError(ctx.getNode(), ackError, { itemIndex: 0 })
							})]);
						}
					});

			} else if (acknowledgeMode === 'laterMessageNode') {
				const responsePromiseHook = await ctx.helpers.createDeferredPromise<IExecuteResponsePromiseData>();
				ctx.emit([ctx.helpers.returnJsonArray([item])], responsePromiseHook);
				responsePromiseHook.promise
					.then(async data => {
							//todo use data for nck detection
							try {
								await message.ackAck();
							} catch(ackError) {
								//maybe not proper handling
								ctx.emit([ctx.helpers.returnJsonArray({
									error: new NodeOperationError(ctx.getNode(), ackError, { itemIndex: 0 })
								})]);
							}
					});
			} else {
				ctx.emit([ctx.helpers.returnJsonArray([item])]);
			}
		} catch (msgErr) {
			if (acknowledgeMode !== 'immediately') {
				message.nak();
			}
			// NON-terminal: message parse failed
			ctx.emit([ctx.helpers.returnJsonArray({
				error: new NodeOperationError(ctx.getNode(), msgErr, { itemIndex: 0 })
			})]);
		}
	}
}
