// argparse programs (Graph.cli): how a command is typed, and which commands run a function
import type { CliArg, CliCommand, CliProgram, Graph } from './types'

/** Choices shown in the command itself; more go in a list of their own. */
export const FEW_CHOICES = 5

/** One argument as usage text: [--json], [--plane frr|ovs], <case>, {link-up|link-down}. */
export function argText(a: CliArg): string {
  const flag = a.action === 'store_true' || a.action === 'store_false' || a.action === 'count'
  const few = a.choices && a.choices.length <= FEW_CHOICES ? a.choices.join('|') : null
  const value = few ?? (a.metavar || (a.opt ? a.name.replace(/^-+/, '').toUpperCase() : a.name))
  const body = a.opt ? (flag ? a.name : `${a.name} ${few ? `{${few}}` : value}`) : (few ? `{${few}}` : `<${value}>`)
  const many = a.nargs === '*' || a.nargs === '+' ? ' …' : ''
  return a.opt && !a.required ? `[${body}${many}]` : `${body}${many}`
}

/** The whole command line: python3 harness/lab3.py check <case> [--json] */
export function usage(p: CliProgram, c?: CliCommand): string {
  return [p.prog, c?.name, ...(c?.args ?? []).map(argText)].filter(Boolean).join(' ')
}

/** Functions every command of a program runs (an emit() that prints the result): they tell no command apart. */
export function commonRuns(p: CliProgram): Set<string> {
  const with_ = p.cmds.filter((c) => c.run.length)
  if (with_.length < 2) return new Set()
  return new Set(with_[0].run.filter((id) => with_.every((c) => c.run.includes(id))))
}

/** The commands that run a function, leaving out one every command runs. */
export function commandsOf(g: Graph, fid: string): { p: CliProgram; c: CliCommand }[] {
  const out: { p: CliProgram; c: CliCommand }[] = []
  for (const p of g.cli ?? []) {
    const common = commonRuns(p)
    if (common.has(fid)) continue
    for (const c of p.cmds) if (c.run.includes(fid)) out.push({ p, c })
  }
  return out
}
