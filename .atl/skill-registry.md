# Skill Registry

This file registers all available skills for the NearHome project.

## Skills

### balena-os

- **Trigger**: "balena", "balenaOS", "openbalena", "openBalena", "edge gateway", "raspberry pi vpn"
- **Description**: Set up and manage balenaOS devices with openBalena VPN for remote connectivity
- **Location**: `/Users/monotributistar/.config/opencode/skills/balena-os/SKILL.md`

### sdd-init

- **Trigger**: "sdd init", "iniciar sdd", "openspec init", "initialize sdd"
- **Description**: Initialize Spec-Driven Development context in any project
- **Location**: `/Users/monotributistar/.config/opencode/skills/sdd-init/SKILL.md`

### sdd-explore

- **Trigger**: "explore", "sdd-explore", "investigate"
- **Description**: Explore and investigate ideas before committing to a change
- **Location**: `/Users/monotributistar/.config/opencode/skills/sdd-explore/SKILL.md`

### sdd-propose

- **Trigger**: "propose", "sdd-propose", "proposal"
- **Description**: Create a change proposal with intent, scope, and approach
- **Location**: `/Users/monotributistar/.config/opencode/skills/sdd-propose/SKILL.md`

### sdd-spec

- **Trigger**: "spec", "sdd-spec", "specification"
- **Description**: Write specifications with requirements and scenarios
- **Location**: `/Users/monotributistar/.config/opencode/skills/sdd-spec/SKILL.md`

### sdd-design

- **Trigger**: "design", "sdd-design", "architect"
- **Description**: Create technical design document with architecture decisions
- **Location**: `/Users/monotributistar/.config/opencode/skills/sdd-design/SKILL.md`

### sdd-tasks

- **Trigger**: "tasks", "sdd-tasks", "task breakdown"
- **Description**: Break down a change into an implementation task checklist
- **Location**: `/Users/monotributistar/.config/opencode/skills/sdd-tasks/SKILL.md`

### sdd-apply

- **Trigger**: "apply", "sdd-apply", "implement"
- **Description**: Implement tasks from the change, writing actual code
- **Location**: `/Users/monotributistar/.config/opencode/skills/sdd-apply/SKILL.md`

### sdd-verify

- **Trigger**: "verify", "sdd-verify", "validate"
- **Description**: Validate that implementation matches specs, design, and tasks
- **Location**: `/Users/monotributistar/.config/opencode/skills/sdd-verify/SKILL.md`

### sdd-archive

- **Trigger**: "archive", "sdd-archive", "close"
- **Description**: Sync delta specs to main specs and archive a completed change
- **Location**: `/Users/monotributistar/.config/opencode/skills/sdd-archive/SKILL.md`

## Usage

When a task matches a skill's trigger keywords, load the skill using:

```
Load skill: balena-os
```

## Adding New Skills

1. Create skill directory: `~/.config/opencode/skills/<skill-name>/`
2. Create SKILL.md with skill documentation
3. Add entry to this registry
