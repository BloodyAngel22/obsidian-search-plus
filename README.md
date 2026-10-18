# Hybrid Search

[![Available in Obsidian](https://img.shields.io/badge/Available%20in%20Obsidian-7C3AED?logo=obsidian&logoColor=white&style=flat-square)](https://obsidian.md/plugins?id=hybrid-search)
[![Release](https://github.com/flowing-abyss/obsidian-hybrid-search-plugin/actions/workflows/release.yml/badge.svg)](https://github.com/flowing-abyss/obsidian-hybrid-search-plugin/actions/workflows/release.yml)
[![Downloads](https://img.shields.io/github/downloads/flowing-abyss/obsidian-hybrid-search-plugin/total?style=flat-square&label=downloads&color=blue)](https://github.com/flowing-abyss/obsidian-hybrid-search-plugin/releases)

Hybrid Search combines BM25 full-text search with semantic vector search across your Obsidian vault.

The plugin provides the Obsidian interface. The [obsidian-hybrid-search](https://github.com/flowing-abyss/obsidian-hybrid-search) CLI runs in the background and handles indexing and search.

Hybrid Search works with the desktop version of Obsidian.

![Search modal with results, preview and local graph](https://raw.githubusercontent.com/flowing-abyss/obsidian-hybrid-search-plugin/master/assets/modal.png)

## Requirements

Install the CLI globally with npm.

```bash
npm install -g obsidian-hybrid-search
```

The CLI must be available in your `PATH`. You can also set a custom path in the plugin settings.

## Installation

Open [Hybrid Search](https://community.obsidian.md/plugins/hybrid-search) in the Obsidian Community plugins directory and select **Add to Obsidian**.

## Usage

Open the search window in either of these ways.

- Select the search icon in the left sidebar.
- Open the command palette and run `Hybrid search: Open search`.

Results update as you type and include a relevance score.

<details>
<summary>Hybrid search results with relevance scores</summary>

![Hybrid search results with relevance scores](https://raw.githubusercontent.com/flowing-abyss/obsidian-hybrid-search-plugin/master/assets/search.png)

</details>

| Score      | Color  | Meaning          |
| ---------- | ------ | ---------------- |
| >0.8       | Green  | High relevance   |
| 0.5 to 0.8 | Orange | Medium relevance |
| <0.5       | Gray   | Low relevance    |

### Empty query and similar notes

Leave the query empty to see results based on the current context.

- If a note is open, the plugin shows semantically similar notes.
- If no note is open, it shows recently opened files.

<details>
<summary>Semantically similar notes</summary>

![Semantically similar notes](https://raw.githubusercontent.com/flowing-abyss/obsidian-hybrid-search-plugin/master/assets/similar.png)

</details>

### Workbench

The link discovery workbench helps you find useful connections for the current note. It compares graph structure with semantic similarity.

- **Best** shows the top candidates based on structural and semantic signals.
- **Missing Links** shows related notes that are not linked yet.
- **Bridges** shows notes that connect distant parts of the graph.
- **Similar** shows semantically close notes.
- **Links** shows existing outgoing and incoming links.
- **Diagnostics** explains the note's position in the graph.

Each candidate includes scores for cosine similarity, Adamic-Adar, common neighbors, co-citation count, semantic distance, and other signals. You can add links, inspect backlinks, and compare notes from the list. The local graph shows the notes around the current file.

<details>
<summary>Link discovery workbench</summary>

![Link-discovery workbench with local graph and scored candidates](https://raw.githubusercontent.com/flowing-abyss/obsidian-hybrid-search-plugin/master/assets/workbench.png)

</details>

## Query syntax

These two queries are equivalent.

```
hybrid: zettelkasten tag:project limit:20 @rerank
```

```
zettelkasten #project @limit:20 @rerank @hybrid
```

| Inline                | Postfix                  | Description                                 |
| --------------------- | ------------------------ | ------------------------------------------- |
| _(plain text)_        | None                     | Hybrid search (default)                     |
| `hybrid:`             | `@hybrid` / `@hyb`       | Hybrid mode (BM25 + semantic)               |
| `semantic:` / `sem:`  | `@semantic` / `@sem`     | Semantic (vector) only                      |
| `fulltext:` / `full:` | `@full`                  | Full-text (BM25) only                       |
| `title:`              | `@title`                 | Fuzzy title match                           |
| None                  | `@sim` / `@similar`      | Notes similar to the active note            |
| None                  | `@sim:[[Note]]`          | Notes similar to a specific note            |
| None                  | `@sim:"path/note.md"`    | Same, by path                               |
| `tag:` / `tag:#tag`   | `#tag`                   | Filter by tag (include)                     |
| `-tag:` / `-tag:#tag` | `-#tag`                  | Filter by tag (exclude)                     |
| `folder:` / `path:`   | None                     | Limit to a folder (quote names with spaces) |
| `-folder:` / `-path:` | None                     | Exclude a folder                            |
| `limit:N`             | `@limit:N` / `@lim:N`    | Override result count                       |
| `threshold:N`         | `@threshold:N` / `@th:N` | Minimum score threshold                     |
| None                  | `@rerank`                | Rerank with a cross-encoder                 |
| `key:value`           | None                     | Filter by frontmatter field                 |
| `-key:value`          | None                     | Exclude by frontmatter field                |

## Metadata filters

Both the search modal and the search panel have a compact filter bar under the search field: a mode dropdown and **+ Filter**.

1. Select **+ Filter** and type to find a property. The list shows the YAML properties used in this vault (read from Obsidian's metadata cache) with note counts.
2. Pick a property. A one-line filter row appears (property, condition, values, ×) and a value list opens over the results. Select one or more values (they are combined with OR), or type a value that no note has yet and press Enter. The list shows the selected values at the top; remove one with × or all with **Clear**.
3. Change the condition with the dropdown: **is any of**, **is none of**, **exists**, **is missing**.

The row shows up to two values by name and a count for more (`5 selected`); hover it to see all values. Lists work with the keyboard: arrows, Enter, Escape (focus returns to the row), and a click outside closes them. In a narrow side panel the values move to a second line.

Rows for different properties are combined with AND, and with any operators typed in the query (for example `status:done #pkm`). Filters apply inside the engine before the result limit, in every search mode. With filters and an empty query, the search lists all matching notes with an exact count and a **Load more** button.

The dot before a row shows its state: filled means active, hollow means incomplete (no value yet, does not restrict results), orange means no note currently uses the selected values (they stay selected until you remove them), red means invalid. Hover the row for the reason. Filters are saved and shared between the modal and the panel.

Values are typed like in YAML: `1` (number) and `"1"` (text) are different values. Only YAML frontmatter is used; inline `key:: value` fields are not filterable. Metadata Menu is optional: when it is installed, its Select/Multi/Boolean field definitions add value suggestions, but matching always uses the YAML values the engine indexed.

Metadata filters need an engine that reports the `structuredFiltersV1` capability (`ohs capabilities`). With an older engine the plugin shows an "engine update needed" message instead of unfiltered results.

## Opening results

Opening a result (Enter, a click, or `Mod+O` for a new tab) jumps to the passage that matched, not to the top of the note. Result rows show the heading path and a short snippet of that passage; full-text matches mark the query words.

- In Source mode and Live Preview the cursor is placed at the passage. For full-text matches the matched word is selected.
- In Reading view the note scrolls to the passage and the block is highlighted for a moment. The note stays in Reading view.
- The plugin checks the engine's position against the current note text. If the note changed, it looks for the passage inside the same heading section and accepts it only when there is exactly one match. If the passage cannot be verified (or for title and metadata-only results), the note opens normally.

## Hotkeys

| Hotkey            | Action                            |
| ----------------- | --------------------------------- |
| `Mod+J` / `Mod+K` | Next / previous result            |
| `Mod+P`           | Toggle preview panel              |
| `Mod+G`           | Toggle local graph panel          |
| `Mod+O`           | Open selected in new tab          |
| `Mod+Shift+O`     | Open all results in new tabs      |
| `Alt+Enter`       | Insert wiki link to selected note |
| `Alt+Shift+Enter` | Insert wiki links to all results  |

`Mod` means `Ctrl` on Windows and Linux or `Cmd` on macOS. `Alt` means `Option` on macOS.

## License

MIT
