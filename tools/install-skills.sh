#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
skills_home="${DSH_HOME:-$HOME/.dsh}/skills"
remove=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skills-home)
      [ "$#" -ge 2 ] || { echo '--skills-home needs a directory' >&2; exit 2; }
      skills_home="$2"
      shift 2
      ;;
    --remove) remove=true; shift ;;
    --help)
      echo 'Usage: bash tools/install-skills.sh [--skills-home DIR] [--remove]'
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$remove" = false ]; then mkdir -p "$skills_home"; fi
count=0
for source in "$repo_root"/skills/*; do
  [ -f "$source/SKILL.md" ] || continue
  count=$((count + 1))
  name="$(basename "$source")"
  target="$skills_home/$name"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    if [ "$remove" = true ]; then rm "$target"; echo "removed $name";
    else echo "present $name"; fi
  elif [ -e "$target" ] || [ -L "$target" ]; then
    echo "Refusing to replace existing skill: $target" >&2
    exit 1
  elif [ "$remove" = false ]; then
    ln -s "$source" "$target"
    echo "linked $name -> $source"
  fi
done
[ "$count" -gt 0 ] || { echo 'No repository skills found' >&2; exit 1; }
echo "DSH skills: $skills_home"
