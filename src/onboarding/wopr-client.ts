export interface ConversationEntry {
  ts: number;
  from: string;
  content: string;
  type: string;
}

export interface IWoprClient {
  createSession(name: string, context: string): Promise<void>;
  getSessionHistory(name: string, limit?: number): Promise<ConversationEntry[]>;
  inject(name: string, message: string, options?: { from?: string; stream?: boolean }): Promise<string>;
  deleteSession(name: string): Promise<void>;
  healthCheck(): Promise<boolean>;
}

export class WoprClient implements IWoprClient {
  private readonly baseUrl: string;
  private authToken: string | null = null;

  constructor(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  setAuthToken(token: string): void {
    this.authToken = token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) {
      h.Authorization = `Bearer ${this.authToken}`;
    }
    return h;
  }

  async createSession(name: string, context: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name, context }),
    });
    if (!res.ok) {
      throw new Error(`WoprClient.createSession failed: ${res.status} ${await res.text()}`);
    }
  }

  async getSessionHistory(name: string, limit = 50): Promise<ConversationEntry[]> {
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(name)}/history?limit=${limit}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`WoprClient.getSessionHistory failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { history?: ConversationEntry[] };
    return data.history ?? [];
  }

  async inject(name: string, message: string, options: { from?: string; stream?: boolean } = {}): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(name)}/inject`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ message, from: options.from ?? "user", stream: options.stream ?? false }),
    });
    if (!res.ok) {
      throw new Error(`WoprClient.inject failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { response?: string };
    return data.response ?? "";
  }

  async deleteSession(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`WoprClient.deleteSession failed: ${res.status} ${await res.text()}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`, { headers: this.headers() });
      return res.ok;
    } catch {
      return false;
    }
  }
}
