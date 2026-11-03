@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "stack_build_arg="
set "stack_env_file="
set "stack_pause=1"
set "stack_exit_code=0"

pushd "%~dp0.." >nul 2>&1
if errorlevel 1 (
    echo Could not open the project folder. 1>&2
    exit /b 1
)

:parse
if "%~1"=="" goto prerequisites
if /i "%~1"=="--help" goto help
if /i "%~1"=="-h" goto help
if /i "%~1"=="--build" (
    set "stack_build_arg=--build"
    shift
    goto parse
)
if /i "%~1"=="--no-build" (
    set "stack_build_arg=--no-build"
    shift
    goto parse
)
if /i "%~1"=="--no-pause" (
    set "stack_pause=0"
    shift
    goto parse
)
if /i "%~1"=="--env-file" (
    if "%~2"=="" goto missing_env_file
    set "stack_env_file=%~2"
    shift
    shift
    goto parse
)
echo Unknown option. Use --help for usage. 1>&2
goto failed

:missing_env_file
echo --env-file requires a file path relative to the project root. 1>&2
goto failed

:prerequisites
docker compose version >nul 2>&1
if errorlevel 1 goto docker_unavailable
docker info >nul 2>&1
if errorlevel 1 goto docker_unavailable

rem Resolved Compose configuration contains secrets; never print it.
call :compose config --quiet >nul 2>&1
if errorlevel 1 (
    echo Docker Compose configuration failed. Check the environment file and compose.yaml. 1>&2
    goto failed
)
type ".local\tls\localhost.pem" >nul 2>&1
if errorlevel 1 goto certificates_missing
type ".local\tls\localhost-key.pem" >nul 2>&1
if errorlevel 1 goto certificates_missing

if not defined stack_build_arg call :detect_build
if errorlevel 1 goto failed

call :compose up -d %stack_build_arg% --wait --wait-timeout 60
if errorlevel 1 (
    echo The stack did not become healthy. Check Docker Compose service status and logs. 1>&2
    goto failed
)

rem Node runs inside the app container; no host Node.js installation is needed.
call :compose exec -T web node --input-type=module -e "import { config } from './dist/server/app/config.js'; console.log('Website ready: ' + config().publicUrl);" 2>nul
if errorlevel 1 echo Stack is healthy. Open the configured APP_PUBLIC_URL.
goto finish

:docker_unavailable
echo Start Docker Desktop with Linux containers and Docker Compose installed. 1>&2
goto failed

:certificates_missing
echo Create readable .local\tls\localhost.pem and localhost-key.pem first. See docs\local-https.md. 1>&2
goto failed

:help
echo Usage: scripts\start-stack.cmd [--build ^| --no-build] [--env-file file] [--no-pause]
echo Starts the HTTPS Docker stack and waits for service health. Existing volumes are preserved.
echo By default, rebuild missing or outdated application images; reuse images when build inputs match.
echo Use --build to force a build or --no-build to skip the source check and reuse existing images.
echo By default, errors pause so they remain visible when double-clicking. Use --no-pause for automation.
goto finish

:failed
set "stack_exit_code=1"

:finish
popd
if not "%stack_exit_code%"=="0" if "%stack_pause%"=="1" pause
exit /b %stack_exit_code%

:compose
if defined stack_env_file (
    docker compose -f compose.yaml --env-file "%stack_env_file%" %*
) else (
    docker compose -f compose.yaml %*
)
exit /b %errorlevel%

:detect_build
docker image inspect efactura-manager:development >nul 2>&1
if errorlevel 1 (
    echo Application image is missing; building it.
    set "stack_build_arg=--build"
    exit /b 0
)
docker run --rm --network none --mount "type=bind,source=%CD%,target=/workspace,readonly" --entrypoint node efactura-manager:development /workspace/scripts/build-inputs.mjs check /workspace
set "stack_check_exit=%errorlevel%"
if "%stack_check_exit%"=="0" (
    echo Application image matches the current source; reusing it.
    set "stack_build_arg=--no-build"
    exit /b 0
)
if "%stack_check_exit%"=="10" (
    echo Application build inputs changed or the image has no fingerprint; rebuilding.
    set "stack_build_arg=--build"
    exit /b 0
)
echo Could not check the application image. Startup stopped. 1>&2
exit /b 1
