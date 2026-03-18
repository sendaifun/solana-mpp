import { charge as charge_ } from './Charge.js'
import { session as session_ } from './Session.js'

export function solana(parameters: solana.Parameters): ReturnType<typeof charge_> {
  return charge_(parameters)
}

export namespace solana {
  export type Parameters = charge_.Parameters
  export const charge = charge_
  export const session = session_
}
