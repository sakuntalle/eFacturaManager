#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

compose=(docker compose -f compose.yaml)
build=auto
while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            printf '%s\n' 'Usage: ./scripts/start-stack.sh [--build | --no-build] [--env-file <file>]'
            printf '%s\n' 'Starts the HTTPS Docker stack and waits for service health. Existing volumes are preserved.'
            printf '%s\n' 'By default, reuse existing images and containers; Compose builds missing images. Use --build after source changes.'
            exit 0
            ;;
        --build)
            build=true
            shift
            ;;
        --no-build)
            build=false
            shift
            ;;
        --env-file)
            if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
                printf '%s\n' '--env-file requires a file path relative to the project root.' >&2
                exit 1
            fi
            compose+=(--env-file "$2")
            shift 2
            ;;
        *)
            printf '%s\n' 'Unknown option. Use --help for usage.' >&2
            exit 1
            ;;
    esac
done

if ! docker compose version >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    printf '%s\n' 'Start Docker Desktop or the Docker daemon, with Docker Compose installed.' >&2
    exit 1
fi

# Resolved Compose configuration contains secrets; never print it.
if ! "${compose[@]}" config --quiet >/dev/null 2>&1; then
    printf '%s\n' 'Docker Compose configuration failed. Check the environment file and compose.yaml.' >&2
    exit 1
fi

if [[ ! -r .local/tls/localhost.pem || ! -r .local/tls/localhost-key.pem ]]; then
    printf '%s\n' 'Create readable .local/tls/localhost.pem and localhost-key.pem first. See docs/local-https.md.' >&2
    exit 1
fi

start_args=(up -d)
if [[ "$build" == true ]]; then
    start_args+=(--build)
elif [[ "$build" == false ]]; then
    start_args+=(--no-build)
fi
start_args+=(--wait --wait-timeout 60)
"${compose[@]}" "${start_args[@]}"

# Use the app's own configuration inside Docker; no host Node.js installation is needed.
if stack_url="$("${compose[@]}" exec -T web node --input-type=module -e \
    'import { config } from "./dist/server/app/config.js"; process.stdout.write(config().publicUrl);' 2>/dev/null)"; then
    printf 'Website ready: %s\n' "$stack_url"
else
    printf '%s\n' 'Stack is healthy. Open the configured APP_PUBLIC_URL.'
fi
