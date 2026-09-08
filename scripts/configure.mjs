import { spawnSync } from 'node:child_process';
import { defaults } from './settings.mjs';
import { readProfiles, saveAgent, profilePath } from './profiles.mjs';
import { connectLangfuse } from './delivery.mjs';
import { collectConfig } from './wizard.mjs';
import { choose, withPrompts } from './prompts.mjs';

export async function configureAgent(agent) {
  return withPrompts(async io => {
    const config = readProfiles(), binding = config.agents[agent];
    const names = Object.keys(config.targets);
    const selected = names.length ? await choose(io.ask, 'Choose an existing target to share its project, or create a separate project target.', [
      ...names.map(name => ({ label: `${name}: ${config.targets[name].base_url} / ${config.targets[name].project_name}`, value: name })),
      { label: 'Create a new target', value: '' },
    ]) : '';
    if (selected === null) return;
    const targetName = selected || (await io.ask(`New target name [${agent}]: `)).trim() || agent;
    if (!selected && config.targets[targetName]) throw new Error('That target name already exists. Select it from the list, or choose a new name.');
    const first = Object.values(config.targets)[0];
    const current = { ...defaults, enabled: true, base_url: first?.base_url || 'http://localhost:3000',
      organization_name: first?.organization_name || 'Personal', project_name: agent === 'codex' ? 'Codex' : 'WorkBuddy',
      public_key: '', secret_key: '', ...binding, ...(selected ? config.targets[selected] : {}) };
    const settings = await collectConfig(current, { ...io, openBrowser: async url => {
      if (spawnSync('open', [url], { stdio: 'ignore' }).status !== 0) console.log(`Open ${url} in your browser.`);
    } });
    const connected = await connectLangfuse(settings);
    // Agent configuration changes take effect only after its old runtime is stopped.
    if (binding && agent === 'workbuddy') {
      const { requireWorkBuddyClosed } = await import('./cli.mjs');
      requireWorkBuddyClosed();
      const { workbuddyCommand } = await import('./workbuddy.mjs');
      await workbuddyCommand('stop', []);
    }
    const saved = saveAgent(agent, targetName, settings, connected);
    console.log(`Saved: ${profilePath()}\nAgent: ${agent}\nTarget: ${saved.targetName}\nProject: ${saved.project_name}\nContent: ${saved.content}\nRun langfuse-helper ${agent} start when ready.`);
    if (agent === 'codex') console.log('Start a new Codex task after changing the target or content mode. Existing tasks keep their original binding.');
    return saved;
  });
}
