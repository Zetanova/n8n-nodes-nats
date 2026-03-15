import {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
	NodeOperationError,
} from 'n8n-workflow';

import Container from 'typedi';
import { NatsService } from '../Nats.service';
import { NatsNodeMessageOptions } from '../Nats/actions/message';
import { consumeMessages } from './actions/consumer';

export class JetStreamTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'NATS - JetStream Trigger',
		name: 'jetStreamTrigger',
		icon: 'file:jetstream.svg',
		group: ['trigger'],
		version: 1,
		description: 'Consumer JetStream stream message',
		eventTriggerDescription: '',
		defaults: {
			name: 'JetStream Trigger',
		},
		triggerPanel: {
			header: '',
			executionsHelp: {
				inactive:
					"<b>While building your workflow</b>, click the 'listen' button, then trigger a JetStream stream message. This will trigger an execution, which will show up in this editor.<br /> <br /><b>Once you're happy with your workflow</b>, <a data-key='activate'>activate</a> it. Then every time a change is detected, the workflow will execute. These executions will show up in the <a data-key='executions'>executions list</a>, but not in the editor.",
				active:
					"<b>While building your workflow</b>, click the 'listen' button, then trigger a JetStream stream message. This will trigger an execution, which will show up in this editor.<br /> <br /><b>Your workflow will also execute automatically</b>, since it's activated. Every time a change is detected, this node will trigger an execution. These executions will show up in the <a data-key='executions'>executions list</a>, but not in the editor.",
			},
			activationHint:
				"Once you've finished building your workflow, <a data-key='activate'>activate</a> it to have it also listen continuously (you just won't see those executions here).",
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'natsApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Stream',
				name: 'stream',
				type: 'string',
				default: '',
				placeholder: 'stream',
				description: 'The name of the stream',
			},
			{
				displayName: 'Consumer',
				name: 'consumer',
				type: 'string',
				default: '',
				placeholder: 'consumer',
				description: 'The name of the consumer',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				default: {},
				placeholder: 'Add Option',
				options: [
					{
						displayName: 'Content Is Binary',
						name: 'contentIsBinary',
						type: 'boolean',
						default: false,
						description: 'Whether to save the content as binary',
					},
					{
						displayName: 'JSON Parse Body',
						name: 'jsonParseBody',
						type: 'boolean',
						default: false,
						description: 'Whether to parse the body to an object',
					},
					{
						displayName: 'Message Acknowledge When',
						name: 'acknowledge',
						type: 'options',
						options: [
									{
										name: 'Execution Finishes',
										value: 'executionFinishes',
										description: 'After the workflow execution finished. No matter if the execution was successful or not.',
									},
									{
										name: 'Execution Finishes Successfully',
										value: 'executionFinishesSuccessfully',
										description: 'After the workflow execution finished successfully',
									},
									{
										name: 'Immediately',
										value: 'immediately',
										description: 'As soon as the message got received',
									},
									{
										name: 'Specified Later in Workflow',
										value: 'laterMessageNode',
										description: 'Using a NATS - JetStream node to remove the item from the queue',
									},
						],
						default: 'immediately',
						description: 'When to acknowledge the message',
					},
					{
						displayName: 'Only Content',
						name: 'onlyContent',
						type: 'boolean',
						default: false,
						description: 'Whether to return only the content property',
					},
					{
						displayName: 'Parallel Message Processing Limit',
						name: 'parallelMessages',
						type: 'number',
						default: -1,
						description: 'Max number of executions at a time. Use -1 for no limit.',
					},
				]
			},
			{
				displayName:
					"To acknowledge an message from the consumer, insert a NATS - JetStream node later in the workflow and use the 'Acknowledge Message' operation",
				name: 'laterMessageNode',
				type: 'notice',
				displayOptions: {
					show: {
						'/options.acknowledge': ['laterMessageNode'],
					},
				},
				default: '',
			},
		]
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const stream = this.getNodeParameter('stream') as string;
		const consumer = this.getNodeParameter('consumer') as string;
		const options = this.getNodeParameter('options', {}) as IDataObject & NatsNodeMessageOptions;

		let parallelMessages =
			options.parallelMessages !== undefined && options.parallelMessages !== -1
				? parseInt(options.parallelMessages as string, 10)
				: -1;

		if (parallelMessages === 0 || parallelMessages < -1) {
			throw new NodeOperationError(
				this.getNode(),
				'Parallel message processing limit must be greater than zero (or -1 for no limit)',
			);
		}

		if (this.getMode() === 'manual') {
			parallelMessages = 1;
		}

		let acknowledgeMode = options.acknowledge ? options.acknowledge : 'immediately';

		const nats = await Container.get(NatsService).getJetStream(this)

		const jsConsumer = await nats.js.consumers.get(stream, consumer);
		const messages = await jsConsumer.consume({ max_messages: parallelMessages });

		let closing = false;

		const consume = () => consumeMessages(
			{ emit: this.emit.bind(this), emitError: this.emitError.bind(this), helpers: this.helpers, getNode: this.getNode.bind(this) },
			messages,
			{ ...options, acknowledge: acknowledgeMode as string },
		);

		// signal n8n on unexpected termination so it can reactivate the workflow
		consume().then(
			() => {
				if (!closing) {
					nats[Symbol.dispose]()
					this.emitError(new Error('JetStream consumer closed unexpectedly'))
				}
			},
			(err) => {
				if (!closing) {
					nats[Symbol.dispose]()
					this.emitError(err)
				}
			}
		)

		// Monitor connection health — force-close consumer if connection dies
		nats.connection.closed().then(() => {
			if (!closing) {
				messages.close().catch(() => {});
			}
		}).catch((err) => {
			if (!closing) {
				this.emitError(err instanceof Error ? err : new Error(String(err)));
			}
		});

		// Monitor consumer status for critical events
		(async () => {
			try {
				for await (const status of messages.status()) {
					if (closing) break;
					if (status.type === 'heartbeats_missed' ||
						status.type === 'consumer_not_found' ||
						status.type === 'stream_not_found' ||
						status.type === 'consumer_deleted') {
						if (!closing) {
							await messages.close().catch(() => {});
						}
						break;
					}
				}
			} catch {
				if (!closing) {
					messages.close().catch(() => {});
				}
			}
		})();

		const closeFunction = async () => {
			closing = true;
			await messages.close();
			nats[Symbol.dispose]()
		};

		return {
			closeFunction,
		};
	}
}
