export class BaseProvider {
  constructor() {
    if (this.constructor === BaseProvider) {
      throw new Error("BaseProvider is abstract");
    }
  }

  get name() {
    throw new Error("Provider name not implemented");
  }

  get label() {
    throw new Error("Provider label not implemented");
  }

  async login(credentials) {
    throw new Error("login() not implemented");
  }

  async *chat(messages, options) {
    throw new Error("chat() not implemented");
  }

  getModels() {
    throw new Error("getModels() not implemented");
  }

  getAccountInfo() {
    throw new Error("getAccountInfo() not implemented");
  }

  isAuthenticated() {
    throw new Error("isAuthenticated() not implemented");
  }

  async createChatSession() {
    return null;
  }

  async deleteChatSession(sessionId) {
    return null;
  }
}
