/** DO API response types (only what we need) */
export interface DODroplet {
  id: number;
  name: string;
  status: "new" | "active" | "off" | "archive";
  region: { slug: string; name: string };
  size: { slug: string; memory: number; vcpus: number; disk: number; price_monthly: number };
  networks: {
    v4: Array<{ ip_address: string; type: "public" | "private" }>;
  };
  created_at: string;
}

export interface DORegion {
  slug: string;
  name: string;
  available: boolean;
  sizes: string[];
}

export interface DOSize {
  slug: string;
  memory: number; // MB
  vcpus: number;
  disk: number; // GB
  price_monthly: number;
  available: boolean;
  regions: string[];
  description: string;
}

export class DOApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly doMessage: string,
  ) {
    super(`DO API error ${statusCode}: ${doMessage}`);
    this.name = "DOApiError";
  }
}

export class DOClient {
  private readonly baseUrl = "https://api.digitalocean.com/v2";
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  /** Create a droplet */
  async createDroplet(params: {
    name: string;
    region: string;
    size: string;
    image: string;
    ssh_keys: number[];
    tags: string[];
    user_data?: string;
  }): Promise<DODroplet> {
    return this.post<{ droplet: DODroplet }>("/droplets", params).then((r) => r.droplet);
  }

  /** Get a droplet by ID */
  async getDroplet(id: number): Promise<DODroplet> {
    return this.get<{ droplet: DODroplet }>(`/droplets/${id}`).then((r) => r.droplet);
  }

  /** Delete a droplet */
  async deleteDroplet(id: number): Promise<void> {
    await this.del(`/droplets/${id}`);
  }

  /** Reboot a droplet by ID (power cycle) */
  async rebootDroplet(dropletId: number): Promise<void> {
    await this.post(`/droplets/${dropletId}/actions`, { type: "reboot" });
  }

  /** List available regions */
  async listRegions(): Promise<DORegion[]> {
    return this.get<{ regions: DORegion[] }>("/regions").then((r) => r.regions.filter((r) => r.available));
  }

  /** List available sizes */
  async listSizes(): Promise<DOSize[]> {
    return this.get<{ sizes: DOSize[] }>("/sizes").then((r) => r.sizes.filter((s) => s.available));
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      throw new DOApiError(res.status, (body as { message?: string }).message ?? res.statusText);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ message: res.statusText }));
      throw new DOApiError(res.status, (errBody as { message?: string }).message ?? res.statusText);
    }
    return res.json() as Promise<T>;
  }

  private async del(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 204) {
      const errBody = await res.json().catch(() => ({ message: res.statusText }));
      throw new DOApiError(res.status, (errBody as { message?: string }).message ?? res.statusText);
    }
  }
}
