# SpecPilot

English | [简体中文](https://github.com/fynism/SpecPilot/blob/v0.1.1/README_zh.md)

SpecPilot helps you turn a software idea into clear requirements before you start coding.
Run it in your project directory: it explores your repository, asks focused questions, and
records your confirmed requirements, scope, product decisions, and acceptance examples.

## Install

You need **Node.js 22.12 or later**, an API key, and a model that supports the Anthropic API
and tool use. Model requests use your configured provider and may incur API charges.

```sh
npm install -g @fyismus/specpilot
```

Or download and run it without a global installation:

```sh
npx @fyismus/specpilot@latest
```

## Get started

Open a terminal in the project you want to work on, then run:

```sh
specpilot
```

On your first interactive launch, SpecPilot opens a configuration wizard if configuration
is missing. Enter:

1. **API protocol:** choose **Anthropic**. OpenAI configuration can be saved, but running
   the OpenAI protocol is not supported yet.
2. **Base URL:** your provider's HTTPS API base URL. Keep any required path prefix, but do
   not enter the full messages endpoint, account credentials, query parameters, or a URL fragment.
3. **Model ID:** the exact model identifier supplied by your provider.
4. **API key:** your provider's key. Input is masked and supports pasting.

Saving does not test the connection or guarantee provider compatibility. API settings are
reused across projects and stored in `~/.specpilot/config.json` (`~` is your user directory).
**The API key is stored in plain text with restricted file access.** Keep this file private.

To change these settings later:

```sh
specpilot config
```

This command saves your settings and exits. Start `specpilot` again to use them.

## Clarify a requirement

Start with a concrete goal:

```text
/clarify Add a password reset flow to this application
```

SpecPilot investigates the repository and opens a clarification overview. Answer the
questions, revise an earlier answer, or defer a question you cannot answer yet. Your edits
are saved as drafts; press **c** in the overview to submit them together and continue.

Use **Enter** to edit a question, **Tab** to switch between the current round and all topics,
**d** to defer or restore a question, and **b** to return to chat. Returning to chat does not
submit your drafts or end clarification. Use `/clarify` to reopen existing progress.

Ordinary chat is for discussion and repository investigation. Use `/clarify <requirement>`
explicitly to start or continue requirement work. To stop clarification and get a summary
of what is already known, use `/done`; this does not automatically export a specification.

## Commands

| Command | What it does |
| --- | --- |
| `/clarify <requirement>` | Start or continue clarifying a concrete requirement. |
| `/clarify` | Open existing clarification progress. |
| `/new [title]` | Create a separate session and switch to it. |
| `/sessions` | List sessions for the current project working directory. |
| `/switch [session-id]` | Pick a session or switch by its full ID. |
| `/rename <title>` | Rename the current session. |
| `/status` | Show session, specification, and token usage information. |
| `/compact` | Summarize older context in a long conversation. |
| `/done` | Stop clarification and summarize confirmed information and open questions. |
| `/language en-US` | Switch fixed full-screen UI labels to English. |
| `/language zh-CN` | Switch fixed full-screen UI labels to Simplified Chinese. |
| `/quit` | Exit the application. |

The language setting applies to UI labels in the current process; it does not translate
past messages, specifications, or model replies. CLI help and some prompts remain in Chinese.

Use `specpilot --help` for command help and `specpilot --version` for the installed version.
Both work without API configuration.

## Your data

Sessions, conversation history, and clarification drafts are saved locally under
`.specpilot/sessions-v5/` in the directory where you start SpecPilot. Restart in the same
directory to return to the last active session. Different project directories keep separate sessions.

When a specification is exported, its files are written to:

```text
.specpilot/specs/<spec_id>/spec.json
.specpilot/specs/<spec_id>/SPEC.md
```

Keep `.specpilot/` out of version control if it contains private project information.
Repository content and conversation context used for model requests are sent to your
configured API provider. Review generated requirements before using them for implementation.

## Environment configuration

For scripts, CI, or an existing `.env` setup, you can supply Anthropic settings through
environment variables or a `.env` file in the project directory:

```dotenv
ANTHROPIC_API_KEY=your_api_key
MODEL_ID=your_provider_model_id
MAX_TOOL_USE_TURNS=20
```

Optionally set `ANTHROPIC_BASE_URL` for a compatible provider. Never commit real API keys.

- Project `.env` values override matching process environment variables.
- If `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` is present, even with an empty value,
  that connection configuration takes precedence over the saved user configuration.
  Remove both fields to use the saved connection settings.
- `MODEL_ID` can override the saved model independently.
- `MAX_TOOL_USE_TURNS` must be a positive integer; the default is `20`.

Non-interactive runs do not open the configuration wizard. Configure the CLI beforehand or
supply these variables. `specpilot config` requires an interactive terminal.

## Current limitations

- Only the Anthropic protocol can run; OpenAI support is limited to saving configuration.
- Use one SpecPilot process per project working directory. Recovery works between completed
  rounds, not in the middle of a model or tool call. Interrupted work is not automatically replayed.
- Sessions from older storage formats are not automatically migrated.
- Long conversations may be summarized to fit the context window; summaries can lose detail.
  Original conversation history remains saved locally.

## Update and feedback

```sh
npm install -g @fyismus/specpilot@latest
```

Report problems or suggest improvements through
[GitHub Issues](https://github.com/fynism/SpecPilot/issues).
