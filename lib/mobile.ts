export function isMobileUserAgent(userAgent: string | null | undefined): boolean {
  return /Mobile|Android|iPhone|iPad|iPod|MicroMessenger/i.test(userAgent ?? '')
}
