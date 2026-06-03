// Small shared shapes.

export class ChatRequest {
  constructor({ model, messages, tools = null, toolChoice = null, temperature = null, maxTokens = null, extra = null }) {
    this.model = model;
    this.messages = messages;
    this.tools = tools;
    this.toolChoice = toolChoice;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.extra = extra;
  }
}
