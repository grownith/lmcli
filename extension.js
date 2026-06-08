// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const {JSONParser} = require('@streamparser/json-node');

const outputChannel = vscode.window.createOutputChannel('lmcli Claude CLI');

/**
 * @param {string} rawArgs
 * @returns {string[]}
 */
function splitArgs(rawArgs) {
	if(!rawArgs || rawArgs.trim().length === 0)
		return [];

	const re = /(?:(?:"([^"]*)")|([^\s"]+))/g;
	const args = [];
	let match;
	while((match = re.exec(rawArgs)))
		args.push(match[1] ?? match[2]);
	return args;
}

/**
 * @param {unknown} part
 * @returns {string}
 */
function flattenPart(part) {
	if(part instanceof vscode.LanguageModelTextPart)
		return part.value;

	if(!part || typeof part !== 'object')
		return String(part ?? '');

	if('value' in part && typeof part.value === 'string')
		return part.value;

	return JSON.stringify(part);
}

/**
 * @param {string} prompt
 * @returns {string[]}
 */
function getClaudeArgs(prompt) {
	const config = vscode.workspace.getConfiguration('lmcli');
	const rawArgs = config.get('lmcli.claudeCliArgs','');
	const args = splitArgs(rawArgs).map(arg => arg.replace('{{prompt}}',prompt));
	if(!args.some(arg => arg.includes(prompt)))
		args.push(prompt);
	return args;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
	console.log('Congratulations, your extension "lmcli" is now active!');

	if(!vscode.lm || typeof vscode.lm.registerLanguageModelChatProvider !== 'function')
	{
		console.error('Language Model Chat API is not available in this VS Code version.');
		return;
	}

	const {execa} = await import('execa');
	const config = vscode.workspace.getConfiguration('lmcli');
	function claude(/** @type {string[]} */...args) {
		const claudeCliPath = config.get('lmcli.claudeCliPath','claude');
		return execa(claudeCliPath,args);
	}

	const child = claude("-p","--output-format=stream-json","--verbose","--input-format=stream-json");
	const parser = new JSONParser({
		paths: ['$']
	},{
		defaultEncoding: 'utf8',
	});

	context.subscriptions.push({
		dispose: () => {
			parser.destroy();
			child.kill();
		}
	});

	const disposable = vscode.lm.registerLanguageModelChatProvider('lmcli',{
		async provideLanguageModelChatInformation(_options,_token) {
			void _options;
			void _token;

			const result = await claude("-v");
			if(result.failed)
				throw new Error(result.stderr);

			return [
				{
					id: 'claude-cli',
					name: 'Claude CLI',
					family: 'claude',
					version: result.stdout,
					tooltip: 'Local Claude CLI chat model',
					maxInputTokens: 12000,
					maxOutputTokens: 2000,
					capabilities: {
						imageInput: false,
						toolCalling: true
					},
					// Hints used by Copilot Chat's model picker to surface BYOK / third-party providers.
					isDefault: false,
					isUserSelectable: true
				}
			];
		},
		async provideLanguageModelChatResponse(model,messages,_options,progress,token) {
			messages.map((msg) => {
				return {
					type: "user",
					message: {
						role: msg.role == vscode.LanguageModelChatMessageRole.User ? "user" : "assistant",
						content: msg.content.map((part) => {
							// Handle text content
							if(part instanceof vscode.LanguageModelTextPart)
								return { type: "text", text: part.value };
							
							// Handle tool calls
							if(part instanceof vscode.LanguageModelToolCallPart)
								return { type: "tool_use", id: part.callId, name: part.name, input: part.input };
							
							// Handle tool results
							if(part instanceof vscode.LanguageModelToolResultPart)
								return { type: "tool_result", tool_use_id: part.callId, content: flattenPart(part.content) };
							
							// Fallback for unknown types
							return { type: "text", text: flattenPart(part) };
						})
					}
				};
			}).forEach((message) => {
				child.stdin.write(JSON.stringify(message));
				child.stdin.write('\n');
			});
			
			for await (const data of child) {
				progress.report(new vscode.LanguageModelTextPart(data));
				if(token.isCancellationRequested)
					break;
			}
		},
		provideTokenCount(_model,text,_token) {
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
function deactivate() { }

module.exports = {
	activate,
	deactivate
};
