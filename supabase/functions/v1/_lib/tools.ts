// opencode CLI builtin tool definitions, captured verbatim from a real
// opencode 1.18.31 CLI request to the zen /v1/responses endpoint (2026-09-18).
//
// WHY THIS EXISTS: since 2026-09-18 the zen free tier also fingerprints the
// request body's `tools` array. A request whose tools omit, rename, or
// replace the opencode builtins (too few real builtin names present) is
// rejected with 403 FreeTierError "OpenCode's free tier can only be used
// from within OpenCode", even when the header fingerprint is perfect.
// Carrying the full builtin set (client tools appended after) passes.
//
// What the gate checks (probed 2026-09-18):
//   - the builtin NAME set must be present; missing/renamed builtins fail
//   - descriptions may be edited or stubbed (stubbing also stops the model
//     from spontaneously calling tools the client cannot execute)
//   - arbitrary client-defined tools may be appended after the builtins
//
// If the gate trips again, re-capture a real CLI request with
// scripts/capture-server.ts and refresh this array (README -> troubleshooting).
import type { UpstreamTool } from "./types.ts"

export const OPENCODE_BUILTIN_TOOLS: UpstreamTool[] = [
  {
    type: "function",
    name: "bash",
    description: "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nBe aware: OS: linux, Shell: bash\n\nAll commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.\n\nUse `/tmp/opencode` for temporary work outside the workspace. This directory has already been created, already exists, and is pre-approved for external directory access.\n\nIMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., rm \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - mkdir \"/Users/name/My Documents\" (correct)\n     - mkdir /Users/name/My Documents (incorrect)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after 120000ms.\n  - If the output exceeds 2000 lines or 51200 bytes, it will be truncated and the full output will be written to a file.\n  - Avoid using Bash with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or when these commands are truly necessary. Instead, always prefer using the dedicated tools for these commands:\n    - File search: Use Glob (NOT find or ls)\n    - Content search: Use Grep (NOT grep or rg)\n    - Read files: Use Read (NOT cat/head/tail)\n    - Edit files: Use Edit (NOT sed/awk)\n    - Write files: Use Write (NOT echo >/cat <<EOF)\n    - Communication: Output text directly (NOT echo/printf)\n  - When issuing multiple commands:\n    - If the commands are independent and can run in parallel, make multiple bash tool calls in a single message.\n    - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.\n    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail\n    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)\n  - AVOID using `cd <directory> && <command>`. Use the `workdir` parameter to change directories instead.\n\n# Git and GitHub\n- Only commit, amend, push, or create PRs when explicitly requested.\n- Before committing, inspect `git status`, `git diff`, and `git log --oneline -10`; stage only intended files and never commit secrets.\n- Write a concise commit message that matches the repo style.\n- Do not update git config, skip hooks, use interactive `-i`, force-push, or create empty commits unless explicitly requested.\n- If a commit fails or hooks reject it, fix the issue and create a new commit; do not amend the failed commit.\n- Before creating a PR, inspect status, diff, remote tracking, recent commits, and the diff from the base branch.\n- Review all commits included in the PR, not just the latest commit.\n- Use `gh` for GitHub tasks, including PRs, issues, checks, and releases; return the PR URL when done.\n",
    parameters: {
      properties: {
        command: { description: "The command to execute", type: "string" },
        timeout: { description: "Optional timeout in milliseconds", type: "integer" },
        workdir: {
          description: "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.",
          type: "string",
        },
      },
      required: ["command"],
      type: "object",
    },
    strict: false,
  },
  {
    type: "function",
    name: "edit",
    description: "Performs exact string replacements in files. \n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. \n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + colon + space (e.g., `1: `). Everything after that space is the actual file content to match. Never include any part of the line number prefix in the oldString or newString.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `oldString` is not found in the file with an error \"oldString not found in content\".\n- The edit will FAIL if `oldString` is found multiple times in the file with an error \"Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match.\" Either provide a larger string with more surrounding context to make it unique, or use `replaceAll` to change every instance of `oldString`. \n- Use `replaceAll` for replacing and renaming strings across the file.\n",
    parameters: {
      properties: {
        filePath: { description: "The absolute path to the file to modify", type: "string" },
        oldString: { description: "The text to replace", type: "string" },
        newString: { description: "The text to replace it with (must be different from oldString)", type: "string" },
        replaceAll: { description: "Replace all occurences of oldString (default false)", type: "boolean" },
      },
      required: ["filePath", "oldString", "newString"],
      type: "object",
    },
    strict: false,
  },
  {
    type: "function",
    name: "glob",
    description: "- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths\n- Use this tool when you need to find files by name patterns\n- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead\n- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.\n",
    parameters: {
      properties: {
        pattern: { description: "The glob pattern to match files against", type: "string" },
        path: {
          description: "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided.",
          type: "string",
        },
      },
      required: ["pattern"],
      type: "object",
    },
    strict: false,
  },
  {
    type: "function",
    name: "grep",
    description: "- Fast content search tool that works with any codebase size\n- Searches file contents using regular expressions\n- Supports full regex syntax (eg. \"log.*Error\", \"function\\s+\\w+\", etc.)\n- Filter files by pattern with the include parameter (eg. \"*.js\", \"*.{ts,tsx}\")\n- Returns file paths and line numbers with matching lines\n- Use this tool when you need to identify/count the number of matches within a single file or across multiple files\n- When you are doing an open-ended search that may require multiple rounds of grepping, use the Task tool instead\n- When you are searching for a keyword or file name pattern, instead of using the Bash tool with `rg` (ripgrep) directly, use this tool\n",
    parameters: {
      properties: {
        pattern: { description: "The regex pattern to search for in file contents", type: "string" },
        path: { description: "The directory to search in. Defaults to the current working directory.", type: "string" },
        include: { description: "File pattern to include in the search (e.g. \"*.js\", \"*.{ts,tsx}\")", type: "string" },
      },
      required: ["pattern"],
      type: "object",
    },
    strict: false,
  },
  {
    type: "function",
    name: "read",
    description: "Read a file or directory from the local filesystem. If the path does not exist, an error is returned.\n\nUsage:\n- The filePath parameter should be an absolute path.\n- By default, this tool returns up to 2000 lines from the start of the file.\n- The offset parameter is the line number to start reading from (1-indexed).\n- To read later sections, call this tool again with a larger offset.\n- Use the grep tool to find specific content in large files or files with long lines.\n- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.\n- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents \"foo\\n\", you will receive \"1: foo\\n\". For directories, entries are returned one per line (without line numbers) with a trailing `/` for subdirectories.\n- Any line longer than 2000 characters is truncated.\n- Call this tool in parallel when you know there are multiple files you want to read.\n- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.\n- This tool can read image files and PDFs and return them as file attachments.\n",
    parameters: {
      properties: {
        filePath: { description: "The absolute path to the file or directory to read", type: "string" },
        offset: { description: "The line number to start reading from (1-indexed)", type: "integer" },
        limit: { description: "The maximum number of lines to read (defaults to 2000)", type: "integer" },
      },
      required: ["filePath"],
      type: "object",
    },
    strict: false,
  },
  {
    type: "function",
    name: "skill",
    description: "Load a specialized skill when the task at hand matches one of the skills listed in the system prompt.\n\nUse this tool to inject the skill's instructions and resources into current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc in the same directory as the skill.\n\nThe skill name must match one of the skills listed in your system prompt.\n",
    parameters: {
      properties: {
        name: { description: "The name of the skill from available_skills", type: "string" },
      },
      required: ["name"],
      type: "object",
    },
    strict: false,
  },
  {
    type: "function",
    name: "task",
    description: "Launch a new agent to handle complex, multistep tasks autonomously.\n\nWhen using the Task tool, you must specify a subagent_type parameter to select which agent type to use.\n\nWhen NOT to use the Task tool:\n- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly\n- If you are searching for a specific class or function definition, use the Grep tool instead of the Task tool\n- If you are searching for code within a specific file or set of files, use the Grep tool instead\n\n\nUsage notes:\n1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses\n2. Once you have delegated work to an agent, do not duplicate that work yourself. Continue with non-overlapping tasks, or wait for the result. For background tasks, you will be notified automatically when the result is ready.\n3. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result. The output includes a task_id you can reuse later to continue the same subagent session.\n4. Each agent invocation starts with a fresh context unless you provide task_id to resume the same subagent session (which continues with its previous messages and tool outputs). When starting fresh, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.\n5. The agent's outputs should generally be trusted\n6. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent. Tell it how to verify its work if possible (e.g., relevant test commands).\n7. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.\n\nAvailable agent types and the tools they have access to:\n- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how does X work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions.\n- general: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.",
    parameters: {
      properties: {
        description: { description: "A short (3-5 words) description of the task", type: "string" },
        prompt: { description: "The task for the agent to perform", type: "string" },
        subagent_type: { description: "The type of specialized agent to use for this task", type: "string" },
        task_id: {
          description: "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
          type: "string",
        },
        command: { description: "The command that triggered this task", type: "string" },
      },
      required: ["description", "prompt", "subagent_type"],
      type: "object",
    },
    strict: false,
  },
  {
    type: "function",
    name: "todowrite",
    description: "Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.\n\n## When to use\nUse proactively when:\n- The task requires 3+ distinct steps or actions (not just 3 tool calls for a single conceptual step)\n- The work is non-trivial and benefits from planning\n- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list\n- New instructions arrive - capture them as todos\n\n## When NOT to use\nSkip when:\n- The work is a single, straightforward task (or <3 trivial steps)\n- The request is purely informational or conversational\n- Tracking adds no organizational value\n\n## States\n- `pending` - not started\n- `in_progress` - actively working (exactly ONE at a time)\n- `completed` - finished successfully\n- `cancelled` - no longer needed\n\n## Rules\n- Update status in real time; don't batch completions\n- Mark `completed` only after the required work is actually done, including any required verification. Never based on intent.\n- Keep exactly one `in_progress` while work remains\n- If blocked or partial, keep it `in_progress` and add a follow-up todo describing the blocker\n- Preserve user-provided commands verbatim (flags, args, order)\n- Items should be specific and actionable; break large work into smaller steps\n\n## Examples\n\nUse it:\n- \"Add a dark mode toggle and run the tests\" -> multi-step feature + explicit verification\n- \"Rename getCwd to getCurrentWorkingDirectory across the repo\" -> multi-file refactor + verification\n\nSkip when:\n- \"Install dependencies\" -> single step, no tracking needed\n- \"What does this function do?\" -> informational, no tracking needed\n\nWhen in doubt, use it.\n",
    parameters: {
      properties: {
        todos: {
          description: "The updated todo list",
          items: {
            properties: {
              content: { description: "Brief description of the task", type: "string" },
              status: {
                description: "Current status of the task: pending, in_progress, completed, cancelled",
                type: "string",
              },
              priority: { description: "Priority level of the task: high, medium, low", type: "string" },
            },
            required: ["content", "status", "priority"],
            type: "object",
          },
          type: "array",
        },
      },
      required: ["todos"],
      type: "object",
    },
    strict: false,
  },
  {
    type: "function",
    name: "webfetch",
    description: "- Fetches content from a specified URL\n- Takes a URL and optional format as input\n- Fetches the URL content, converts to requested format (markdown by default)\n- Returns the content in the specified format\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: if another tool is present that offers better web fetching capabilities, is more targeted to the task, or has fewer restrictions, prefer using that tool instead of this one.\n  - The URL must be a fully-formed valid URL\n  - HTTP URLs will be automatically upgraded to HTTPS\n  - Format options: \"markdown\" (default), \"text\", or \"html\"\n  - This tool is read-only and does not modify any files\n  - Results may be summarized if the content is very large\n",
    parameters: {
      properties: {
        url: { description: "The URL to fetch content from", type: "string" },
        format: {
          description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
          enum: ["text", "markdown", "html"],
          type: "string",
        },
        timeout: { description: "Optional timeout in seconds (max 120)", type: "number" },
      },
      required: ["url"],
      type: "object",
    },
    strict: false,
  },
  {
    type: "function",
    name: "websearch",
    description: "- Search the web using the session's web search provider - performs real-time web searches and can scrape content from specific URLs\n- Provides up-to-date information for current events and recent data\n- Supports configurable result counts and returns the content from the most relevant websites\n- Use this tool for accessing information beyond knowledge cutoff\n- Searches are performed automatically within a single API call\n\nUsage notes:\n  - Supports live crawling modes when available: 'fallback' (backup if cached unavailable) or 'preferred' (prioritize live crawling)\n  - Search types when available: 'auto' (balanced), 'fast' (quick results), 'deep' (comprehensive search)\n  - Configurable context length for optimal LLM integration\n\nThe current year is 2026. You MUST use this year when searching for recent information or current events\n- Example: If the current year is 2026 and the user asks for \"latest AI news\", search for \"AI news 2026\", NOT \"AI news 2025\"\n",
    parameters: {
      properties: {
        query: { description: "Websearch query", type: "string" },
        numResults: { description: "Number of search results to return (default: 8)", type: "number" },
        livecrawl: {
          description: "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
          enum: ["fallback", "preferred"],
          type: "string",
        },
        type: {
          description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
          enum: ["auto", "fast", "deep"],
          type: "string",
        },
        contextMaxCharacters: {
          description: "Maximum characters for context string optimized for LLMs (default: 10000)",
          type: "number",
        },
      },
      required: ["query"],
      type: "object",
    },
    strict: false,
  },
  {
    type: "function",
    name: "write",
    description: "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.\n",
    parameters: {
      properties: {
        content: { description: "The content to write to the file", type: "string" },
        filePath: { description: "The absolute path to the file to write (must be absolute, not relative)", type: "string" },
      },
      required: ["content", "filePath"],
      type: "object",
    },
    strict: false,
  },
]

// The gate only checks builtin NAMES; descriptions may be stubbed. We ship
// stubs at request time so the model does not spontaneously call CLI tools
// the OpenAI client never declared and cannot execute (probed: a plain-chat
// request carrying the real descriptions triggers bash/read/todowrite calls).
// Client-declared tools keep their own real descriptions.
export const STUB_BUILTIN_TOOL_DESCRIPTION =
  "Reserved opencode CLI tool. Not available in this session; never call it."

// Builtins with stubbed descriptions (shared by the chat, responses, and
// messages facades).
export const STUBBED_BUILTIN_TOOLS: UpstreamTool[] = OPENCODE_BUILTIN_TOOLS.map((tool) => ({
  ...tool,
  description: STUB_BUILTIN_TOOL_DESCRIPTION,
}))

const BUILTIN_NAMES = new Set(OPENCODE_BUILTIN_TOOLS.map((tool) => tool.name))

export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = BUILTIN_NAMES

export function isBuiltinToolName(name: string): boolean {
  if (!name) return false
  return BUILTIN_NAMES.has(name)
}

export function shouldExposeToolCall(name: string, clientToolNames: ReadonlySet<string>): boolean {
  if (clientToolNames.has(name)) return true
  if (BUILTIN_NAMES.has(name)) return false
  return true
}

// The gate only checks the builtin NAME set. Shadow rule: a client tool
// whose name collides with a builtin REPLACES the stub entry in place, so
// the model sees the client's real description/parameters while the name
// set still passes the gate (same rule as the chat facade's lower.ts).
export function appendClientTools(client: UpstreamTool[]): UpstreamTool[] {
  const clientByName = new Map(client.map((tool) => [tool.name, tool]))
  const replaced = STUBBED_BUILTIN_TOOLS.map((tool) => clientByName.get(tool.name) ?? tool)
  const extra = client.filter((tool) => !BUILTIN_NAMES.has(tool.name))
  return [...replaced, ...extra]
}
