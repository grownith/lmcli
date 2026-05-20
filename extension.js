// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const { spawn } = require('child_process');

const outputChannel = vscode.window.createOutputChannel('lmcli Claude CLI');

/**
 * @param {string} rawArgs
 * @returns {string[]}
 */
function splitArgs(rawArgs) {
	if (!rawArgs || rawArgs.trim().length === 0) {
		return [];
	}
	const re = /(?:(?:"([^"]*)")|([^\s"]+))/g;
	const args = [];
	let match;
	while ((match = re.exec(rawArgs))) {
		args.push(match[1] ?? match[2]);
	}
	return args;
}

/**
 * @param {unknown} part
 * @returns {string}
 */
function flattenPart(part) {
	if (part instanceof vscode.LanguageModelTextPart) {
		return part.value;
	}
	if (part && typeof part === 'object') {
		if ('value' in part && typeof part.value === 'string') {
			return part.value;
		}
		return JSON.stringify(part);
	}
	return String(part ?? '');
}

/**
 * @param {readonly vscode.LanguageModelChatRequestMessage[]} messages
 * @returns {string}
 */
function buildPrompt(messages) {
	return messages
		.map(message => {
			const content = Array.isArray(message.content)
				? message.content.map(flattenPart).join('')
				: flattenPart(message.content);
			const role = message.role || 'user';
			const name = message.name ? ` (${message.name})` : '';
			return `${role}${name}: ${content}`;
		})
		.join('\n\n');
}

/**
 * @param {string} prompt
 * @returns {string[]}
 */
function getClaudeArgs(prompt) {
	const config = vscode.workspace.getConfiguration('lmcli');
	const rawArgs = config.get('lmcli.claudeCliArgs', '');
	const args = splitArgs(rawArgs).map(arg => arg.replace('{{prompt}}', prompt));
	if (!args.some(arg => arg.includes(prompt))) {
		args.push(prompt);
	}
	return args;
}

/**
 * @returns {Promise<string>}
 */
function getClaudeVersion() {
	const config = vscode.workspace.getConfiguration('lmcli');
	const claudeCliPath = config.get('lmcli.claudeCliPath', 'claude');

	return new Promise((resolve) => {
		const child = spawn(claudeCliPath, ['-v'], { shell: false });
		let stdout = '';
		let stderr = '';

		child.stdout.on('data', chunk => {
			stdout += String(chunk);
		});

		child.stderr.on('data', chunk => {
			stderr += String(chunk);
		});

		child.on('error', () => {
			resolve('unknown');
		});

		child.on('close', code => {
			if (code !== 0) {
				resolve('unknown');
			} else {
				resolve(stdout.trim() || stderr.trim() || 'unknown');
			}
		});
	});
}

/**
 * @param {unknown} value
 * @param {string[]} results
 */
function extractClaudeText(value, results) {
	if (typeof value === 'string') {
		results.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			extractClaudeText(item, results);
		}
		return;
	}
	if (value && typeof value === 'object') {
		const obj = /** @type {{text?: string; value?: string; [key: string]: unknown}} */ (value);
		if (typeof obj.text === 'string') {
			results.push(obj.text);
		}
		if (typeof obj.value === 'string') {
			results.push(obj.value);
		}
		for (const key of Object.keys(obj)) {
			if (key === 'text' || key === 'value') {
				continue;
			}
			extractClaudeText(obj[key], results);
		}
	}
}

/**
 * @param {vscode.Progress<vscode.LanguageModelResponsePart>} progress
 * @returns {(chunk: Buffer|string) => void}
 */
function createJsonStreamHandler(progress) {
	let buffer = '';

	return chunk => {
		buffer += String(chunk);
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() || '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			try {
				const parsed = JSON.parse(trimmed);
				const pieces = /** @type {string[]} */ ([]);
				extractClaudeText(parsed, pieces);
				const text = pieces.join('');
				if (text) {
					progress.report(new vscode.LanguageModelTextPart(text));
					outputChannel.append(text);
				}
			} catch (error) {
				outputChannel.appendLine(`[json parse error] ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	console.log('Congratulations, your extension "lmcli" is now active!');

	if (!vscode.lm || typeof vscode.lm.registerLanguageModelChatProvider !== 'function') {
		console.error('Language Model Chat API is not available in this VS Code version.');
		return;
	}

	const disposable = vscode.lm.registerLanguageModelChatProvider('lmcli', {
		async provideLanguageModelChatInformation(_options, _token) {
			void _options;
			void _token;
			return [
				{
					id: 'claude-cli',
					name: 'Claude CLI',
					family: 'claude',
					version: await getClaudeVersion(),
					tooltip: 'Local Claude CLI chat model',
					maxInputTokens: 12000,
					maxOutputTokens: 2000,
					capabilities: {
						imageInput: false,
						toolCalling: true
					}
				}
			];
		},
		provideLanguageModelChatResponse(model, messages, _options, progress, token) {
			return new Promise((resolve, reject) => {
				const prompt = buildPrompt(messages);
				const config = vscode.workspace.getConfiguration('lmcli');
				const claudeCliPath = config.get('lmcli.claudeCliPath', 'claude');
				const args = getClaudeArgs(prompt);

				outputChannel.clear();
				outputChannel.show(true);
				outputChannel.appendLine(`Running Claude CLI: ${claudeCliPath} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);
				outputChannel.appendLine(`Prompt:\n${prompt}\n`);

				const child = spawn(claudeCliPath, ["-p","--output-format=stream-json","--verbose", ...args], { shell: false });
				const handleStdout = createJsonStreamHandler(progress);

				if (token && typeof token.onCancellationRequested === 'function') {
					token.onCancellationRequested(() => {
						child.kill();
						reject(new Error('Claude CLI request cancelled.'));
					});
				}

				child.stdout.on('data', handleStdout);

				child.stderr.on('data', chunk => {
					outputChannel.append(`\n[stderr] ${chunk}`);
				});

				child.on('error', error => {
					reject(new Error(`Failed to start Claude CLI: ${error.message}`));
				});

				child.on('close', code => {
					if (code !== 0) {
						reject(new Error(`Claude CLI exited with code ${code}`));
					} else {
						resolve(undefined);
					}
				});
			});
		},
		provideTokenCount(_model, text, _token) {
			void _model;
			void _token;
			const content = typeof text === 'string' ? text : JSON.stringify(text);
			return Promise.resolve(
				content
					.split(/\s+/)
					.filter(Boolean)
					.length
			);
		},
		onDidChangeLanguageModelChatInformation: () => {
			return {
				dispose: () => {
					console.log("dispose");
				}
			};
		}
	});
	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
};
