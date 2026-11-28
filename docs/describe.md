# AI descriptions

codemap never calls an AI itself. `codemap describe` writes prompts for what is not
described yet, in four rounds, each resting on the one below it:

1. functions: what each does
2. files, the commands of an argparse program and the allowed values of their
   arguments, environment variables, the files the code reads and writes,
   the functions outside the repository it calls, and the types and file-level
   variables each file defines (with a note on the fields that need one)
3. components, from what their files do
4. the project (two or three sentences), a reading route (the functions to read
   first, in order) and a glossary of the project's own words

## Running the rounds

```sh
codemap describe                       # prompts for the lowest round not done, in .codemap/prompts/
# give each prompt-NN.md to an AI, save its JSON answer as answer-NN.json beside it, then
codemap describe --apply .codemap/prompts/answer-*.json --by claude-opus-5-5
codemap describe                       # the next round, until it says everything is described
codemap describe --status              # each round: up to date, stale, wrong, missing
```

To have an AI agent (Claude Code, in this repository) do every round by itself,
give it the instruction `codemap describe` prints after the prompts: run describe,
answer each prompt, apply, fix what was not kept, and go on until everything is
described.

What it says on screen is in English, like every command. The instruction for an
AI agent is in English, or in Chinese with `--lang zh-TW`; the choice is kept in
`~/.config/codemap/settings.json` for next time.

## Choosing what to describe

With no file named it takes the whole project (not its tests: `--tests`), only
what has no up-to-date description (all of it: `--rewrite`), 12 functions (each
with its parameters and contract) or 30 items to a prompt (`--batch N`). `--level N` writes round N even if one below
is not done. Name files to take only their functions: `codemap describe
src/client.c -o prompt.md`. After the code changes, the same `codemap describe`
asks again for just what changed.

## Types, variables and constants

Types and file-level variables get an AI description in round 2, from their
definition and the functions that use it. A type's description turns stale when its definition changes, not
when the functions that use it do. A constant or macro goes to the AI only when
its author commented it, and every commented field gets a note (a long type's
fields are asked for 60 at a time, as items of their own, def:FILE:NAME#fields-2 and on): the comment is in
its author's language, which may not be the reader's. The AI explains what the
comment leaves out; it does not translate the comment, which is shown as written.

## What a function's description holds

A function's description comes with `info`, short facts a reader needs to use or
change it, each about one line where it can be: what runs it and what that
forbids, the data outside it it reads or writes, each parameter's role (in, out,
in-out) and meaning, what each return value means, its side effects, its
contract (pre, post, error, ownership), and, apart, the pitfalls and mismatches
it falls into, which the viewer shows under Checks. An `info` item is not kept
where its line is outside the function, it names a parameter the function does
not have, or a part or kind is not one of these. A description written before
`info` was asked for is asked for again by the next `codemap describe`.

## What is kept, and when it goes stale

Each description is in Traditional Chinese and English, cites the lines it rests
on, and is kept in `.codemap/descriptions.json` with a hash of what it describes
(the function's source, the file, the functions a command runs, the lines a
variable is read on). An answer is not kept where it cites a line outside what
it describes (a function and its neighbours; a file; a command's functions; the
project may cite any file, its README too), a name in `code` font the code does
not have, a term on a line without that word, or a route step that neither
calls the next nor is a place the program starts (nothing in the repository
calls it). The viewer shows them in the overview (This project, Where to start reading,
Terms, the components, and the commands, values, variables and data files in
their tables), in a file's panel and for each function. A function changed since
is shown as stale (after the facts, faded); `codemap check` lists the stale and
the wrong ones. `codemap where NAME` prints every kind of description, and
`codemap callers NAME -d` / `callees NAME -d` print them for each function listed.

The viewer lists what is still to be written, and the prompts that wait for an answer or for
`--apply`; see [the viewer](viewer.md#descriptions-not-written-yet).
