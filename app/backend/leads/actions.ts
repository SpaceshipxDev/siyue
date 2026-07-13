'use server'

import { revalidatePath } from 'next/cache'
import { supabase } from '@/lib/supabase'
import { requireCommerce } from '@/lib/auth'

// Stamp / unstamp contacted_at on a lead. Commerce-only — mirrors the page's
// own layout guard (app/backend/layout.tsx) as defense in depth, since a
// server action is its own reachable endpoint.

export async function markContactedAction(id: string): Promise<void> {
  await requireCommerce()
  const { error } = await supabase
    .from('leads')
    .update({ contacted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/backend/leads')
}

export async function undoContactedAction(id: string): Promise<void> {
  await requireCommerce()
  const { error } = await supabase
    .from('leads')
    .update({ contacted_at: null })
    .eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/backend/leads')
}
