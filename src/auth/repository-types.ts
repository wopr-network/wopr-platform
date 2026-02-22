export interface SessionRecord {
  id: string;
  userId: string;
  roles: string[];
  createdAt: number;
  expiresAt: number;
}
