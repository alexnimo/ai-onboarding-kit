#!/usr/bin/env bash
#
# AI Agent Onboarding Scaffolder - Unix / bash
#
# Reads onboard.manifest.json and:
#   1. Creates the directory structure
#   2. Copies template files (never overwrites existing files unless --force)
#   3. Checks which skills are missing across 4+ locations
#   4. With --install-skills: installs missing skills via npx skills add
#   5. With --update-skills: updates already-installed skills via npx skills update
#   6. Merges MCP server config (non-destructive) for the target agent
#   7. With --config-only: skips templates, only configures skills + MCP
#   8. Prints a summary report
#   9. Registers the project + records .agents/onboarding-state.json (best-effort, needs node)
#
# Usage:
#   ./scaffold.sh [--target <dir>] [--agent <name>] [--install-skills]
#                 [--update-skills] [--config-only] [--force] [--manifest <path>]
#
set -euo pipefail

TARGET="$(pwd)"
AGENT="devin"
INSTALL_SKILLS=false
UPDATE_SKILLS=false
CONFIG_ONLY=false
FORCE=false
DRY_RUN=false
ONLY_FILE=""
MANIFEST_PATH=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --target)         TARGET="$2"; shift 2 ;;
        --agent)          AGENT="$2"; shift 2 ;;
        --install-skills) INSTALL_SKILLS=true; shift ;;
        --update-skills)  UPDATE_SKILLS=true; shift ;;
        --config-only)    CONFIG_ONLY=true; shift ;;
        --force)          FORCE=true; shift ;;
        --manifest)       MANIFEST_PATH="$2"; shift 2 ;;
        --dry-run)        DRY_RUN=true; shift ;;
        --only)           ONLY_FILE="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 [--target <dir>] [--agent <name>] [--install-skills] [--update-skills] [--config-only] [--force] [--manifest <path>]"
            echo ""
            echo "Agents: devin, hermes, opencode, claude-code, cursor, windsurf, omp"
            exit 0 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

# Resolve manifest path
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$MANIFEST_PATH" ]]; then
    MANIFEST_PATH="$SCRIPT_DIR/onboard.manifest.json"
fi

if [[ ! -f "$MANIFEST_PATH" ]]; then
    echo "ERROR: Manifest not found: $MANIFEST_PATH" >&2
    exit 1
fi

TEMPLATE_ROOT="$(cd "$(dirname "$MANIFEST_PATH")" && pwd)"

# Check for jq
if ! command -v jq &>/dev/null; then
    echo "ERROR: jq is required but not installed. Install it first:" >&2
    echo "  brew install jq  |  apt install jq  |  choco install jq" >&2
    exit 1
fi

# Windows jq.exe emits CRLF line endings - strip \r from all jq output so -r
# values are clean. PIPESTATUS preserves jq's own exit code for `jq -e` checks.
jq() {
    command jq "$@" | tr -d '\r'
    return "${PIPESTATUS[0]}"
}

# Validate agent profile exists
if ! jq -e --arg a "$AGENT" '.agentProfiles[$a]' "$MANIFEST_PATH" &>/dev/null; then
    echo "ERROR: Agent profile '$AGENT' not found in manifest." >&2
    echo "Available: $(jq -r '.agentProfiles | keys | join(", ")' "$MANIFEST_PATH")" >&2
    exit 1
fi

# --- dry-run / --only machinery ---
# In dry-run mode the script still performs all READS (existence checks,
# skill detection) so rows reflect reality, but every mutation is replaced
# by a fact row. Human output moves to stderr; stdout carries the JSON
# array alone so callers can capture it cleanly.
ROWS_FILE=""
emit_row() {
    # emit_row <artifact> <action> [detail] [global]
    [[ -z "$ROWS_FILE" ]] && return 0
    jq -cn --arg a "$1" --arg act "$2" --arg d "${3:-}" --arg g "${4:-false}" \
        '({artifact:$a, action:$act} + (if $d != "" then {detail:$d} else {} end)
          + (if $g == "true" then {global:true} else {} end))' >> "$ROWS_FILE"
}
allowed() {
    # allowed <artifact> -> 0 when --only is unset or the artifact (or a
    # path inside a listed dir) appears in the --only file.
    [[ -z "$ONLY_FILE" ]] && return 0
    [[ ! -f "$ONLY_FILE" ]] && return 0
    grep -qxF "$1" "$ONLY_FILE" && return 0
    grep -qxF "${1%/*}" "$ONLY_FILE" && return 0
    return 1
}
if [[ "$DRY_RUN" == true ]]; then
    ROWS_FILE="$(mktemp)"
    trap 'rm -f "$ROWS_FILE"' EXIT
    exec 3>&1 1>&2   # human output -> stderr; JSON goes to fd3 at the end
fi

PROFILE_MCP_PATH=$(jq -r --arg a "$AGENT" '.agentProfiles[$a].mcpConfigPath' "$MANIFEST_PATH")

echo ""
echo "=== AI Agent Onboarding Scaffolder ==="
echo "Target:         $TARGET"
echo "Agent:          $AGENT"
echo "Manifest:       $MANIFEST_PATH"
echo "Config only:    $CONFIG_ONLY"
echo "Install skills: $INSTALL_SKILLS"
echo "Update skills:  $UPDATE_SKILLS"
echo ""

# --- 1. Create directories ---
if [[ "$CONFIG_ONLY" == false ]]; then
    echo "--- Directories ---"
    while IFS= read -r dir; do
        dest_dir="$TARGET/$dir"
        allowed "$dir" || continue
        if [[ -d "$dest_dir" ]]; then
            echo "  [exists]  $dir"
            emit_row "$dir" "exists-skip" "directory exists"
        elif [[ "$DRY_RUN" == true ]]; then
            echo "  [would create] $dir"
            emit_row "$dir" "create" "create directory"
        else
            mkdir -p "$dest_dir"
            echo "  [created] $dir"
        fi
    done < <(jq -r '.directories[]' "$MANIFEST_PATH")

    # --- 2. Copy templates ---
    echo ""
    echo "--- Templates ---"
    created_count=0
    skipped_count=0

    while IFS=$'\t' read -r src dest overwrite; do
        src_path="$TEMPLATE_ROOT/$src"
        dest_path="$TARGET/$dest"
        dest_dir="$(dirname "$dest_path")"

        if [[ ! -f "$src_path" ]]; then
            echo "  [missing source] $src"
            continue
        fi

        should_overwrite="false"
        [[ "$FORCE" == true || "$overwrite" == "true" ]] && should_overwrite="true"

        if [[ "$should_overwrite" == false && -f "$dest_path" ]]; then
            echo "  [skip exists] $dest"
            emit_row "$dest" "exists-skip" "file exists; kit never overwrites it"
            ((++skipped_count))
            continue
        fi

        allowed "$dest" || continue
        if [[ "$DRY_RUN" == true ]]; then
            echo "  [would create] $dest"
            emit_row "$dest" "create" "install template"
            ((++created_count))
            continue
        fi

        mkdir -p "$dest_dir"
        if grep -q '{{KIT_REGION}}' "$src_path" 2>/dev/null; then
            # Expand the kit-region directive: the block file content lands
            # between the markers the template already ships.
            region_src="$TEMPLATE_ROOT/$(jq -r '.managedRegions[0].src // empty' "$MANIFEST_PATH")"
            if [[ -f "$region_src" ]]; then
                awk -v blockfile="$region_src" '
                    /{{KIT_REGION}}/ {
                        while ((getline line < blockfile) > 0) {
                            sub(/\r$/, "", line); print line
                        }
                        next
                    }
                    { print }
                ' "$src_path" > "$dest_path"
            else
                cp "$src_path" "$dest_path"
            fi
        else
            cp "$src_path" "$dest_path"
        fi
        echo "  [created] $dest"
        ((++created_count))
    done < <(jq -r '.templates[] | [.src, .dest, (.overwrite // false | tostring)] | @tsv' "$MANIFEST_PATH")
else
    echo "--- Config-only mode: skipping templates ---"
    created_count=0
    skipped_count=0
fi

# --- 3. Check skills ---
echo ""
echo "--- Skills ---"

HOME_AGENTS="$HOME/.agents/skills"
installed_count=0
missing_count=0
missing_required=()
missing_optional=()
installed_names=()

# Build skill search paths from agent profile + defaults
skill_search_dirs=("$HOME_AGENTS")
while IFS= read -r dir; do
    expanded="${dir/#\~/$HOME}"
    if [[ "$expanded" != "$HOME_AGENTS" ]]; then
        skill_search_dirs+=("$expanded")
    fi
done < <(jq -r --arg a "$AGENT" '.agentProfiles[$a].skillDirs[]?' "$MANIFEST_PATH")
skill_search_dirs+=("$TARGET/.windsurf/skills")
skill_search_dirs+=("$TARGET/.agents/skills")

# Read skills as tab-separated name|source|skill|required
while IFS=$'\t' read -r name source skill required; do
    found=false

    # Check all skill search dirs
    for search_dir in "${skill_search_dirs[@]}"; do
        if [[ -f "$search_dir/$name/SKILL.md" ]]; then
            found=true
            break
        fi
    done

    # Check skill-lock.json
    if [[ "$found" == false && -f "$HOME/.agents/.skill-lock.json" ]]; then
        if jq -e --arg n "$name" '.skills[$n]' "$HOME/.agents/.skill-lock.json" &>/dev/null; then
            found=true
        fi
    fi

    tag="optional"
    [[ "$required" == "true" ]] && tag="required"

    if [[ "$found" == true ]]; then
        echo "  [installed] $name ($tag)"
        emit_row "$name" "exists-skip" "skill already installed ($tag)" "true"
        ((++installed_count))
        installed_names+=("$name|$source|$skill")
    else
        echo "  [missing]   $name ($tag)"
        emit_row "$name" "missing-skill" "not installed ($tag): npx skills add ${source}@${skill} -g -y" "true"
        ((++missing_count))
        if [[ "$required" == "true" ]]; then
            missing_required+=("$name|$source|$skill")
        else
            missing_optional+=("$name|$source|$skill")
        fi
    fi
done < <(jq -r '.skills[] | [.name, .source, .skill, (.required | tostring)] | @tsv' "$MANIFEST_PATH")

# --- 4a. Install missing skills ---
if [[ "$INSTALL_SKILLS" == true && ${#missing_required[@]} -gt 0 ]]; then
    echo ""
    echo "--- Installing Missing Skills ---"
    for entry in "${missing_required[@]}"; do
        IFS='|' read -r name source skill <<< "$entry"
        allowed "$name" || continue
        if [[ "$DRY_RUN" == true ]]; then
            emit_row "$name" "install-skill" "would run: npx skills add ${source}@${skill} -g -y" "true"
            echo "  [would install] npx skills add ${source}@${skill} -g -y"
            continue
        fi
        cmd="npx skills add ${source}@${skill} -g -y"
        echo "  [installing] $cmd"
        if eval "$cmd"; then
            echo "  [done] $name"
        else
            echo "  [failed] $name"
        fi
    done
fi

# --- 4b. Update installed skills ---
if [[ "$UPDATE_SKILLS" == true && ${#installed_names[@]} -gt 0 ]]; then
    echo ""
    echo "--- Updating Installed Skills ---"
    for entry in "${installed_names[@]}"; do
        IFS='|' read -r name source skill <<< "$entry"
        allowed "$name" || continue
        if [[ "$DRY_RUN" == true ]]; then
            emit_row "$name" "update-skill" "would run: npx skills update ${source}@${skill} -g -y" "true"
            echo "  [would update] npx skills update ${source}@${skill} -g -y"
            continue
        fi
        cmd="npx skills update ${source}@${skill} -g -y"
        echo "  [updating] $name"
        if eval "$cmd"; then
            echo "  [done] $name"
        else
            echo "  [skipped] $name - already up to date or failed"
        fi
    done
fi

# --- 4c. Template skills (kit-bundled skills copied to ~/.agents/skills/) ---
# These are skills that ship with the kit (e.g. ui-design-orchestrator) and are
# installed by copying the template dir, NOT via `npx skills add`. They are global
# (shared by all agents) so this runs regardless of CONFIG_ONLY.
template_skills_copied=0
template_skills_skipped=0
template_skills_count=$(jq -r '.templateSkills | length' "$MANIFEST_PATH" 2>/dev/null || echo 0)
if [[ "$template_skills_count" -gt 0 ]]; then
    echo ""
    echo "--- Template Skills (kit-bundled, global) ---"

    while IFS=$'\t' read -r src dest; do
        src_path="$TEMPLATE_ROOT/$src"
        dest_dir="$HOME_AGENTS/$dest"
        dest_skill_md="$dest_dir/SKILL.md"

        if [[ ! -d "$src_path" ]]; then
            echo "  [missing source] $src"
            continue
        fi

        if [[ -f "$dest_skill_md" ]]; then
            echo "  [exists] $dest"
            emit_row "$dest" "exists-skip" "template skill already installed" "true"
            ((++template_skills_skipped))
            continue
        fi

        allowed "$dest" || continue
        if [[ "$DRY_RUN" == true ]]; then
            echo "  [would copy] $dest -> ~/.agents/skills/$dest"
            emit_row "$dest" "copy-skill" "copy kit-bundled skill to ~/.agents/skills/" "true"
            ((++template_skills_copied))
            continue
        fi

        mkdir -p "$HOME_AGENTS"
        cp -r "$src_path" "$dest_dir"
        echo "  [created] $dest"
        ((++template_skills_copied))
    done < <(jq -r '.templateSkills[] | [.src, .dest] | @tsv' "$MANIFEST_PATH")
fi

# --- 4d. CLI tools (non-skill binaries, e.g. skillui) ---
# Detection only by default; installed with --install-skills using each
# entry's "install" command.
cli_tools_present=0
declare -a cli_tools_missing=()
cli_tools_count=$(jq -r '.cliTools | length' "$MANIFEST_PATH" 2>/dev/null || echo 0)
if [[ "$cli_tools_count" -gt 0 ]]; then
    echo ""
    echo "--- CLI Tools ---"
    while IFS=$'\t' read -r name check install required; do
        if [[ -n "$check" ]] && eval "$check" >/dev/null 2>&1; then
            echo "  [present] $name"
            ((++cli_tools_present))
        elif [[ -z "$check" ]] && command -v "$name" >/dev/null 2>&1; then
            echo "  [present] $name"
            ((++cli_tools_present))
        else
            tag=$([[ "$required" == "true" ]] && echo "required" || echo "optional")
            echo "  [missing] $name ($tag) - $install"
            emit_row "$name" "missing-skill" "CLI tool missing ($tag): $install" "true"
            cli_tools_missing+=("$install")
        fi
    done < <(jq -r '.cliTools[] | [.name, (.check // ""), .install, .required] | @tsv' "$MANIFEST_PATH")

    if [[ "$INSTALL_SKILLS" == true && ${#cli_tools_missing[@]} -gt 0 ]]; then
        for install_cmd in "${cli_tools_missing[@]}"; do
            echo "  [installing] $install_cmd"
            if eval "$install_cmd"; then
                echo "  [done]"
            else
                echo "  [failed] $install_cmd"
            fi
        done
    fi
fi

# --- 5. MCP server config (non-destructive merge) ---
echo ""
echo "--- MCP Servers (agent: $AGENT) ---"

# Resolve MCP config path (relative to target)
mcp_config_path="$TARGET/$PROFILE_MCP_PATH"
mcp_config_dir="$(dirname "$mcp_config_path")"

mcp_added=0
mcp_exists=0

if [[ "$DRY_RUN" == true ]]; then
    # Read-only preview: count manifest servers absent from the config.
    if [[ -f "$mcp_config_path" ]]; then
        echo "  [exists] $PROFILE_MCP_PATH"
    else
        echo "  [new]    $PROFILE_MCP_PATH"
    fi
    mcp_preview_added=()
    while IFS=$'\t' read -r name required; do
        if [[ -f "$mcp_config_path" ]] && jq -e --arg n "$name" '.mcpServers[$n]' "$mcp_config_path" &>/dev/null; then
            echo "  [exists]   $name"
            ((++mcp_exists))
        else
            echo "  [would add] $name"
            mcp_preview_added+=("$name")
            ((++mcp_added))
        fi
    done < <(jq -r '.mcpServers[] | select(.tier != "specialist") | [.name, (.required | tostring)] | @tsv' "$MANIFEST_PATH")
    if [[ ${#mcp_preview_added[@]} -gt 0 || ! -f "$mcp_config_path" ]]; then
        emit_row "$PROFILE_MCP_PATH" "merge-keys" "add ${#mcp_preview_added[@]} server(s): ${mcp_preview_added[*]}"
    fi
elif [[ -f "$mcp_config_path" ]]; then
    echo "  [exists] $PROFILE_MCP_PATH"
else
    echo "  [new]    $PROFILE_MCP_PATH"
    allowed "$PROFILE_MCP_PATH" || { echo "  [skipped by --only] $PROFILE_MCP_PATH"; }
    allowed "$PROFILE_MCP_PATH" && {
        mkdir -p "$mcp_config_dir"
        # Start with empty config
        echo '{"mcpServers":{}}' > "$mcp_config_path"
    }
fi

if [[ "$DRY_RUN" == false ]] && { [[ ! -f "$mcp_config_path" ]] || ! allowed "$PROFILE_MCP_PATH"; }; then
    : # nothing to merge into when the config file was skipped
elif [[ "$DRY_RUN" == false ]]; then

# For each MCP server in manifest, check if it already exists
while IFS=$'\t' read -r name required; do
    if jq -e --arg n "$name" '.mcpServers[$n]' "$mcp_config_path" &>/dev/null; then
        echo "  [exists]   $name"
        ((++mcp_exists))
    else
        # Add the server config from manifest
        config_json=$(jq -r --arg n "$name" '.mcpServers[] | select(.name == $n) | .config' "$MANIFEST_PATH")
        jq --arg n "$name" --argjson cfg "$config_json" \
           '.mcpServers[$n] = $cfg' "$mcp_config_path" > "${mcp_config_path}.tmp" && mv "${mcp_config_path}.tmp" "$mcp_config_path"
        tag="optional"
        [[ "$required" == "true" ]] && tag="required"
        echo "  [added]    $name ($tag)"
        ((++mcp_added))
    fi
done < <(jq -r '.mcpServers[] | select(.tier != "specialist") | [.name, (.required | tostring)] | @tsv' "$MANIFEST_PATH")

if [[ $mcp_added -gt 0 ]]; then
    echo "  [written]  $mcp_config_path"
fi
fi

# --- 5b. Hooks config (non-destructive merge) ---
hooks_added=0
hooks_exists=0
PROFILE_HOOKS_PATH=$(jq -r --arg a "$AGENT" '.agentProfiles[$a].hooksConfigPath // empty' "$MANIFEST_PATH")
PROFILE_HOOKS_FORMAT=$(jq -r --arg a "$AGENT" '.agentProfiles[$a].hooksConfigFormat // empty' "$MANIFEST_PATH")

if [[ -n "$PROFILE_HOOKS_PATH" && -n "$PROFILE_HOOKS_FORMAT" ]]; then
    echo ""
    echo "--- Hooks (agent: $AGENT) ---"

    hooks_config_path="$TARGET/$PROFILE_HOOKS_PATH"
    hooks_config_dir="$(dirname "$hooks_config_path")"

    hooks_config_existed=false
    if [[ -f "$hooks_config_path" ]]; then
        hooks_config_existed=true
        echo "  [exists] $PROFILE_HOOKS_PATH"
    else
        echo "  [new]    $PROFILE_HOOKS_PATH"
    fi

    # Get existing hook event names
    existing_hook_events=""
    if [[ "$hooks_config_existed" == true ]]; then
        if [[ "$PROFILE_HOOKS_FORMAT" == "nested" ]]; then
            existing_hook_events=$(jq -r '.hooks // {} | keys[]?' "$hooks_config_path" 2>/dev/null)
        else
            existing_hook_events=$(jq -r 'keys[]?' "$hooks_config_path" 2>/dev/null)
        fi
    fi

    # Get all hook events from manifest
    manifest_hook_events=$(jq -r '.hooks[].event' "$MANIFEST_PATH" | sort -u)

    hooks_to_add_events=""

    while IFS= read -r event; do
        if echo "$existing_hook_events" | grep -qx "$event"; then
            hook_count=$(jq -r --arg e "$event" '[.hooks[] | select(.event == $e)] | length' "$MANIFEST_PATH")
            echo "  [exists]   $event ($hook_count hook(s))"
            ((++hooks_exists))
        else
            hook_count=$(jq -r --arg e "$event" '[.hooks[] | select(.event == $e)] | length' "$MANIFEST_PATH")
            echo "  [added]    $event ($hook_count hook(s))"
            ((++hooks_added))
            hooks_to_add_events="$hooks_to_add_events $event"
        fi
    done <<< "$manifest_hook_events"

    if [[ "$DRY_RUN" == true ]]; then
        if [[ $hooks_added -gt 0 || "$hooks_config_existed" == false ]]; then
            emit_row "$PROFILE_HOOKS_PATH" "merge-keys" "add $hooks_added hook event(s):${hooks_to_add_events:- none}"
            echo "  [would write] $hooks_config_path"
        fi
    elif [[ $hooks_added -gt 0 || "$hooks_config_existed" == false ]]; then
        if ! allowed "$PROFILE_HOOKS_PATH"; then
            echo "  [skipped by --only] $PROFILE_HOOKS_PATH"
        else
        mkdir -p "$hooks_config_dir"

        # Build hooks JSON from manifest for events that need adding
        hooks_json=$(jq -r '.hooks | group_by(.event) | map({(.[0].event): map({matcher, hooks: [{type, command}]})}) | add // {}' "$MANIFEST_PATH")

        if [[ "$hooks_config_existed" == true ]]; then
            # Merge: only add events that don't exist yet
            if [[ "$PROFILE_HOOKS_FORMAT" == "nested" ]]; then
                for event in $hooks_to_add_events; do
                    event_json=$(jq -r --arg e "$event" '.hooks | group_by(.event) | map({(.[0].event): map({matcher, hooks: [{type, command}]})}) | add | .[$e]' "$MANIFEST_PATH")
                    jq --arg e "$event" --argjson cfg "$event_json" '.hooks[$e] = $cfg' "$hooks_config_path" > "${hooks_config_path}.tmp" && mv "${hooks_config_path}.tmp" "$hooks_config_path"
                done
            else
                for event in $hooks_to_add_events; do
                    event_json=$(jq -r --arg e "$event" '.hooks | group_by(.event) | map({(.[0].event): map({matcher, hooks: [{type, command}]})}) | add | .[$e]' "$MANIFEST_PATH")
                    jq --arg e "$event" --argjson cfg "$event_json" '.[$e] = $cfg' "$hooks_config_path" > "${hooks_config_path}.tmp" && mv "${hooks_config_path}.tmp" "$hooks_config_path"
                done
            fi
        else
            # New file
            if [[ "$PROFILE_HOOKS_FORMAT" == "nested" ]]; then
                echo '{"hooks":{}}' | jq --argjson h "$hooks_json" '.hooks = $h' > "$hooks_config_path"
            else
                echo "$hooks_json" | jq '.' > "$hooks_config_path"
            fi
        fi
        echo "  [written]  $hooks_config_path"
    fi
    fi
else
    echo ""
    echo "--- Hooks: agent '$AGENT' does not support hooks ---"
fi

# --- 5c. Rules (copy rule templates to agent rules dir) ---
rules_copied=0
rules_skipped=0
PROFILE_RULES_DIR=$(jq -r --arg a "$AGENT" '.agentProfiles[$a].rulesDir // empty' "$MANIFEST_PATH")
PROFILE_RULES_ENABLED=$(jq -r --arg a "$AGENT" '.agentProfiles[$a].rulesEnabled // false' "$MANIFEST_PATH")

if [[ "$PROFILE_RULES_ENABLED" == true && -n "$PROFILE_RULES_DIR" ]]; then
    echo ""
    echo "--- Rules (agent: $AGENT) ---"

    rules_dir_path="$TARGET/$PROFILE_RULES_DIR"
    [[ "$DRY_RUN" == false ]] && mkdir -p "$rules_dir_path"

    while IFS=$'\t' read -r src dest overwrite; do
        src_path="$TEMPLATE_ROOT/$src"
        dest_path="$rules_dir_path/$dest"

        if [[ ! -f "$src_path" ]]; then
            echo "  [missing source] $src"
            continue
        fi

        should_overwrite="false"
        [[ "$FORCE" == true || "$overwrite" == "true" ]] && should_overwrite="true"

        if [[ "$should_overwrite" == false && -f "$dest_path" ]]; then
            echo "  [skip exists] $dest"
            emit_row "$PROFILE_RULES_DIR/$dest" "exists-skip" "rule file exists; not overwritten"
            ((++rules_skipped))
            continue
        fi

        allowed "$PROFILE_RULES_DIR/$dest" || continue
        if [[ "$DRY_RUN" == true ]]; then
            echo "  [would create] $dest"
            emit_row "$PROFILE_RULES_DIR/$dest" "create" "install $AGENT rule"
            ((++rules_copied))
            continue
        fi

        cp "$src_path" "$dest_path"
        echo "  [created] $dest"
        ((++rules_copied))
    done < <(jq -r '.rules[] | [.src, .dest, (.overwrite // false | tostring)] | @tsv' "$MANIFEST_PATH")
else
    echo ""
    echo "--- Rules: agent '$AGENT' does not support rule directories ---"
fi

# --- 6. Summary ---
echo ""
echo "=== Summary ==="
if [[ "$CONFIG_ONLY" == false ]]; then
    echo "  Templates created: $created_count"
    echo "  Templates skipped: $skipped_count (already exist)"
fi
echo "  Skills installed:  $installed_count"
echo "  Skills missing:    $missing_count"
echo "  Template skills created: $template_skills_copied"
echo "  Template skills skipped: $template_skills_skipped (already exist)"
echo "  MCP servers present: $mcp_exists"
echo "  MCP servers added:   $mcp_added"
echo "  Hooks present:       $hooks_exists"
echo "  Hooks added:         $hooks_added"
echo "  Rules created:       $rules_copied"
echo "  Rules skipped:       $rules_skipped"
if [[ "$cli_tools_count" -gt 0 ]]; then
    echo "  CLI tools present:   $cli_tools_present"
    echo "  CLI tools missing:   ${#cli_tools_missing[@]}"
fi

if [[ ${#missing_required[@]} -gt 0 ]]; then
    echo ""
    echo "  Missing REQUIRED skills:"
    for entry in "${missing_required[@]}"; do
        IFS='|' read -r name source skill <<< "$entry"
        echo "    - $name: npx skills add ${source}@${skill} -g -y"
    done
    if [[ "$INSTALL_SKILLS" == false ]]; then
        echo ""
        echo "  Re-run with --install-skills to install them."
    fi
fi

if [[ ${#missing_optional[@]} -gt 0 ]]; then
    echo ""
    echo "  Missing OPTIONAL skills (install on demand):"
    for entry in "${missing_optional[@]}"; do
        IFS='|' read -r name source skill <<< "$entry"
        echo "    - $name: npx skills add ${source}@${skill} -g -y"
    done
fi

# --- 7. Next steps ---
echo ""
echo "=== Next Steps ==="
if [[ "$CONFIG_ONLY" == true ]]; then
    echo "  Agent '$AGENT' configured for this project."
    echo "  Skills are shared globally via ~/.agents/skills/"
    echo "  MCP config written to: $PROFILE_MCP_PATH"
else
    echo "  1. Fill {{placeholders}} in generated files (or invoke prompts/onboard-fill.md with your agent runner)"
    echo "  2. Run: npx skills add <source>@<skill> -g -y  for any missing skills"
    echo "  3. Commit the scaffolded files to your repo"
fi

# Show how to onboard additional agents
other_agents=$(jq -r --arg a "$AGENT" '.agentProfiles | keys | map(select(. != $a)) | .[]' "$MANIFEST_PATH")
if [[ -n "$other_agents" ]]; then
    echo ""
    echo "  To onboard additional agents to this project:"
    while IFS= read -r a; do
        echo "    ./scaffold.sh --target \"$TARGET\" --agent $a --config-only --install-skills"
    done <<< "$other_agents"
fi
echo ""

# --- 8. Onboarding registry + state (best-effort, requires Node.js) ---
# Never fails the scaffold: warns and continues when node or the CLI is missing.
ONBOARD_CLI="$TEMPLATE_ROOT/bin/onboard.mjs"
if [[ -f "$ONBOARD_CLI" && "$DRY_RUN" == false ]]; then
    if command -v node &>/dev/null; then
        # Reason: pwd -W yields native Windows paths under Git bash/MSYS so the
        # registry key matches what node's path.resolve produces; fall back to
        # plain pwd on real POSIX systems where -W doesn't exist.
        TARGET_ABS="$(cd "$TARGET" && { pwd -W 2>/dev/null || pwd; })"
        PROJECT_NAME="$(basename "$TARGET_ABS")"
        # Foreign instructions files gain the kit region via node (single
        # implementation of marker injection shared with sync). Runs before
        # record-state so the region is recorded, not just injected.
        node "$ONBOARD_CLI" inject-regions --path "$TARGET_ABS" --manifest "$MANIFEST_PATH" --agents "$AGENT" || true
        if ! node "$ONBOARD_CLI" register --name "$PROJECT_NAME" --path "$TARGET_ABS" --agents "$AGENT" \
            || ! node "$ONBOARD_CLI" record-state --path "$TARGET_ABS" --manifest "$MANIFEST_PATH"; then
            echo "WARNING: onboarding registry/state recording failed (non-fatal)." >&2
        fi
    else
        echo "WARNING: node not found - skipping onboarding registry/state recording." >&2
    fi
elif [[ "$DRY_RUN" == true ]]; then
    # Fact rows only - the node-side planner (onboard-plan.mjs) computes the
    # real injection/merge/register previews with diffs.
    echo "  [would run] inject-regions + register + record-state"
    emit_row "(project)" "register" "register project in kit registry (node preview owns the diff)"
fi

# --- dry-run plan JSON (stdout; human output above went to stderr) ---
# @@PLAN_JSON@@ sentinel: node callers split on it so any chatter that
# leaks into stdout can't corrupt the parse.
if [[ "$DRY_RUN" == true ]]; then
    echo "@@PLAN_JSON@@" >&3
    jq -s '.' "$ROWS_FILE" >&3
fi
