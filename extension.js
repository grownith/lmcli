// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');

const outputChannel = vscode.window.createOutputChannel('lmcli Claude CLI');

const OFFICIAL_EXTENSION_ID = 'Anthropic.claude-code';

/**
 * Resolve the claude executable, mimicking the official extension: prefer the
 * claude.exe it bundles, so we drive the exact same engine. Honor an explicit
 * user override first; fall back to `claude` on PATH if the bundle is gone.
 * @returns {string}
 */
function resolveClaudePath() {
	const override = vscode.workspace.getConfiguration('lmcli').get('lmcli.claudeCliPath', '');
	if(override && override.trim().length > 0)
		return override;

	const ext = vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID);
	if(ext) {
		const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
		const bundled = path.join(ext.extensionPath, 'resources', 'native-binary', exe);
		if(fs.existsSync(bundled))
			return bundled;
		outputChannel.appendLine(`Bundled binary not found at ${bundled}; falling back to 'claude' on PATH.`);
	} else {
		outputChannel.appendLine(`Extension ${OFFICIAL_EXTENSION_ID} not found; falling back to 'claude' on PATH.`);
	}
	return 'claude';
}

/**
 * Map a VS Code chat message into a stream-json `user` input line.
 * @param {vscode.LanguageModelChatMessage} msg
 * @returns {object}
 */
function toStreamJsonUser(msg) {
	const content = msg.content.map((part) => {
		if(part instanceof vscode.LanguageModelTextPart)
			return { type: 'text', text: part.value };
		if(part instanceof vscode.LanguageModelToolCallPart)
			return { type: 'tool_use', id: part.callId, name: part.name, input: part.input };
		if(part instanceof vscode.LanguageModelToolResultPart) {
			const text = part.content
				.map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : JSON.stringify(c)))
				.join('');
			return { type: 'tool_result', tool_use_id: part.callId, content: text };
		}
		return { type: 'text', text: String(part ?? '') };
	});
	// The CLI maps assistant-role inputs into the transcript too, but the input
	// envelope is always type:"user" with the role carried inside `message`.
	return {
		type: 'user',
		message: {
			role: msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
			content,
		},
		parent_tool_use_id: null,
	};
}

/**
 * One long-lived claude.exe (mimicking the official extension's persistent
 * process), with requests serialized through a queue. The `-p` stream-json
 * interface exposes no per-request correlation id, so concurrent turns would
 * interleave on the shared stdout — the queue guarantees one turn at a time:
 * the next request starts only after the prior turn's `result` event.
 */
class ClaudeSession {
	constructor() {
		/** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
		this.child = null;
		/** @type {readline.Interface | null} */
		this.rl = null;
		/** @type {((obj: object) => void) | null} active turn's event sink */
		this.onEvent = null;
		/** @type {Promise<void>} tail of the serialization chain */
		this.queue = Promise.resolve();
	}

	async ensureStarted() {
		if(this.child && this.child.exitCode === null)
			return;

		const { spawn } = require('node:child_process');
		const exe = resolveClaudePath();
		outputChannel.appendLine(`Launching: ${exe}`);
		this.child = spawn(exe, [
			'-p',
			'--output-format=stream-json',
			'--input-format=stream-json',
			'--verbose',
		], { stdio: ['pipe', 'pipe', 'pipe'] });

		this.child.stderr.on('data', (d) => outputChannel.append(String(d)));
		this.child.on('exit', (code) => {
			outputChannel.appendLine(`claude exited (code ${code}).`);
			this.child = null;
			this.rl = null;
		});

		// Parse stdout as newline-delimited JSON — each line is one stream-json event.
		this.rl = readline.createInterface({ input: this.child.stdout });
		this.rl.on('line', (line) => {
			const trimmed = line.trim();
			if(!trimmed)
				return;
			let obj;
			try {
				obj = JSON.parse(trimmed);
			} catch {
				outputChannel.appendLine(`Non-JSON line: ${trimmed}`);
				return;
			}
			if(this.onEvent)
				this.onEvent(obj);
		});
	}

	/**
	 * Run one turn: write the messages, stream assistant text/tool-calls to
	 * `progress`, resolve when the terminal `result` event arrives.
	 * @param {vscode.LanguageModelChatMessage[]} messages
	 * @param {vscode.Progress<vscode.LanguageModelResponsePart>} progress
	 * @param {vscode.CancellationToken} token
	 * @returns {Promise<void>}
	 */
	send(messages, progress, token) {
		// Chain onto the queue so turns never overlap on the shared stdout.
		const run = this.queue.then(() => this.#runTurn(messages, progress, token));
		// Keep the chain alive even if this turn throws.
		this.queue = run.catch(() => {});
		return run;
	}

	#runTurn(messages, progress, token) {
		return new Promise((resolve, reject) => {
			this.ensureStarted().then(() => {
				if(!this.child) {
					reject(new Error('claude process is not running.'));
					return;
				}

				const cancel = token.onCancellationRequested(() => {
					// No per-turn cancel over the CLI; kill the process so a stuck
					// turn can't wedge the queue, then surface cancellation.
					this.child?.kill();
					cleanup();
					reject(new vscode.CancellationError());
				});

				const cleanup = () => {
					cancel.dispose();
					this.onEvent = null;
				};

				this.onEvent = (obj) => {
					switch(obj.type) {
						case 'assistant': {
							const blocks = obj.message?.content ?? [];
							for(const block of blocks) {
								if(block.type === 'text')
									progress.report(new vscode.LanguageModelTextPart(block.text));
								else if(block.type === 'tool_use')
									progress.report(new vscode.LanguageModelToolCallPart(block.id, block.name, block.input ?? {}));
							}
							break;
						}
						case 'result': {
							cleanup();
							if(obj.is_error)
								reject(new Error(obj.result || `claude returned ${obj.subtype}`));
							else
								resolve();
							break;
						}
						// 'system' (init) and echoed 'user' events carry no assistant
						// output — ignore them.
					}
				};

				for(const msg of messages) {
					this.child.stdin.write(JSON.stringify(toStreamJsonUser(msg)));
					this.child.stdin.write('\n');
				}
			}).catch(reject);
		});
	}

	dispose() {
		this.rl?.close();
		this.child?.kill();
		this.child = null;
		this.rl = null;
	}
}

// This method is called when your extension is activated
/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
	if(!vscode.lm || typeof vscode.lm.registerLanguageModelChatProvider !== 'function') {
		outputChannel.appendLine('Language Model Chat API is not available in this VS Code version.');
		return;
	}

	const session = new ClaudeSession();
	context.subscriptions.push({ dispose: () => session.dispose() });

	const disposable = vscode.lm.registerLanguageModelChatProvider('lmcli', {
		async provideLanguageModelChatInformation(_options, _token) {
			let version = 'unknown';
			try {
				const { execFile } = require('node:child_process');
				version = await new Promise((resolve, reject) => {
					execFile(resolveClaudePath(), ['--version'], (err, stdout) => {
						if(err)
							reject(err);
						else
							resolve(stdout.trim());
					});
				});
			} catch(err) {
				outputChannel.appendLine(`Could not read claude version: ${err}`);
			}

			return [
				{
					id: 'claude-cli',
					name: 'Claude CLI',
					family: 'claude',
					version,
					tooltip: 'Local Claude CLI (bundled with the official Claude Code extension)',
					maxInputTokens: 200000,
					maxOutputTokens: 64000,
					capabilities: {
						imageInput: false,
						toolCalling: true,
					},
					isDefault: false,
					isUserSelectable: true,
				},
			];
		},

		async provideLanguageModelChatResponse(model, messages, _options, progress, token) {
			await session.send(messages, progress, token);
		},

		provideTokenCount(_model, text, _token) {
			const content = typeof text === 'string' ? text : JSON.stringify(text);
			return Promise.resolve(content.split(/\s+/).filter(Boolean).length);
		},

		onDidChangeLanguageModelChatInformation: () => ({ dispose: () => {} }),
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate,
};
