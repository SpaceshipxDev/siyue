// Default loading state for any route under / that doesn't define its own
// loading.tsx. Renders a single thin top progress bar — no skeleton, no
// layout shift. The bar self-delays 150ms so instant nav stays silent.
import { NavProgress } from './_nav_progress'

export default function Loading() {
  return <NavProgress />
}
