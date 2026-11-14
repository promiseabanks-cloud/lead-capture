export type Note = {
  id: string
  content: string
  createdAt: number
  updatedAt: number
}
export type Session = {
  user: { sub: string; name?: string; email?: string } | null
  mode: 'local' | 'freebuff' | 'setup'
  database: boolean
}
