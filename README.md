# Zen AI

A Dia-style AI chat for [Zen Browser](https://zen-browser.app), powered by your
local [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) or
[Antigravity CLI](https://antigravity.google/docs/cli/reference), using your
existing provider account. Cmd+E opens a floating or docked
panel that can:

- answer questions about the page you're on, your selection, or other tabs (`@`)
- read attached images, PDFs, Word, PowerPoint, Excel and text files
- edit a copy of a file you attach (Word, PowerPoint, Excel, notebooks, text) keeping its formatting
- watch a page until something happens (back in stock, an email arrives): Zen checks it without using the AI, tells you, and can wake Claude to act
- make files in `~/Documents/Claude Output`: PDFs, Word, Excel, Jupyter/Colab notebooks, code and text; each shows as a card at the end of the reply that opens on click and drags onto upload boxes; screenshots and attached images can go inside PDFs, Word files and notebooks
- fill in forms and click through pages, asking before each action
- run your own `/skills` (Markdown files in `<profile>/chrome/zenai-skills`), and make new ones with `/create-skill`: describe it, Claude drafts it, you confirm its settings on a card
- merge what a skill run learned back into the skill, with a reviewed diff
- let a big skill hand independent parts to helper agents (`agents: 2` in its header), shown as small boxes in the reply
- sign in with passwords you saved in `_secrets.md`, filled in by name: the AI never sees them
- switch providers, models and effort to fit your task and usage limit

## Install (macOS)

1. Install Zen and a supported provider: Claude Code (`brew install --cask
   claude-code`) or Antigravity CLI **1.5.9**. Run `claude` or `agy` once in
   Terminal and sign in.
2. Install [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig): copy its
   `program/` folder into `/Applications/Zen.app/Contents/Resources` (Terminal
   needs "App Management" permission) and its `profile/chrome/utils` into your
   Zen profile's `chrome` folder (about:support → Profile Folder).
3. Quit Zen, then from this folder: `sh scripts/install.sh`
4. Open Zen and press **Cmd+E**. Allow the Documents prompt the first time.

After a Zen update, run `sh scripts/install.sh` again: it puts fx-autoconfig's
loader back into Zen.app (set `FX_AUTOCONFIG` if you cloned it somewhere other
than `~/fx-autoconfig`).

Choose the default provider and check its executable in **Zen’s settings →
Zen AI**. The model menu groups installed providers; each provider’s full model
list appears after its first connection. Switching providers starts a new chat,
and saved chats resume with their original provider.

Antigravity uses Zen AI’s browser tools and approval cards. Its built-in search,
fetch, browser, scheduling and subagent tools are disabled, including when shell
and file tools are unlocked. CLI versions other than 1.5.9 are refused until
their permission behavior is verified. Skill merging still requires Claude Code.
Deleting an Antigravity chat removes Zen AI’s copy; it does not delete the CLI’s
transcript. Gemini CLI and Codex CLI adapters are not included in this release.

## Give it to a friend

`npm run kit` makes `out/Zen AI <version>.zip`: the mod, fx-autoconfig and a
double-click installer (`kit/Install Zen AI.command`) with a read-me. It
finds their profile, offers to install Claude Code and sign them in, puts
fx-autoconfig in place (sending them to App Management if macOS says no),
installs the mod and clears Zen's startup cache. They run it again after
each Zen update; `--remove` takes the mod out. They need their own Claude
Pro or Max account.

## Develop

Edit the modules in `src/`, then `npm run build` (it stitches them into
`dist/zen-ai-chat.uc.js`), `npm test`, and `npm run install-zen`.

## Built with

JavaScript (ES modules) · Firefox/Gecko browser APIs · Claude Code and the
Agent Client Protocol · Playwright and jsdom for tests
