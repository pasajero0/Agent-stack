# Scan Project

Analyze the project directory to build a complete profile.

## Steps

1. Read project root: list files, identify config files
2. Parse package.json / pyproject.toml / Cargo.toml for dependencies
3. Identify primary language(s) and framework(s)
4. Map directory structure and identify patterns (src/, lib/, tests/, etc.)
5. Find configuration files (eslint, prettier, tsconfig, biome, etc.)
6. Detect test framework and test file patterns
7. Check for CI/CD setup (.github/workflows/, .gitlab-ci.yml)
8. Identify entry points and build system

## Output

Structured project profile:
- Project name and description
- Languages and frameworks
- Key dependencies
- Directory structure summary
- Configuration tools in use
- Test setup
- CI/CD status
