import { validateConfig } from './settings.mjs';

export async function collectConfig(current, { ask, secret, log, openBrowser }) {
  const value = async (label, fallback) => (await ask(`${label} [${fallback}]: `)).trim() || fallback;
  const yes = async (label, fallback) => {
    for (;;) {
      const answer = (await value(label, fallback ? 'Y' : 'n')).toLowerCase();
      if (['y', 'yes'].includes(answer)) return true;
      if (['n', 'no'].includes(answer)) return false;
      log('Enter y or n, or press Enter to keep the default.');
    }
  };
  log('Configuration is stored in your user directory. Press Enter to keep existing values. API keys are hidden while typing.');
  const config = { ...current, base_url: await value('Langfuse base URL', current.base_url) };
  validateConfig(config);
  if (!await yes('Do you already have an organization, project and project API keys?', !!(current.public_key && current.secret_key))) {
    config.organization_name = await value('Organization name (for creation)', current.organization_name);
    config.project_name = await value('Project name (for creation)', current.project_name);
    log(`Sign in or register at ${config.base_url}, then:\n1. Create organization "${config.organization_name}" or use an existing one.\n2. Create project "${config.project_name}" in that organization.\n3. Create project keys under Settings -> API Keys.\nThis wizard guides you through creation; entering a name does not create an organization or project automatically.`);
    if (await yes('Open Langfuse in your browser now?', true)) await openBrowser(config.base_url);
    await ask('Press Enter when ready, or Ctrl+C to exit and configure later.');
  }
  config.public_key = (await secret(`Project Public Key${current.public_key ? ' (Enter to keep)' : ''}: `)).trim() || current.public_key;
  config.secret_key = (await secret(`Project Secret Key${current.secret_key ? ' (Enter to keep)' : ''}: `)).trim() || current.secret_key;
  for (;;) {
    config.content = await value('Content mode: metadata for structure/usage; text also includes redacted content', current.content);
    if (['metadata', 'text'].includes(config.content)) break;
    log('Enter metadata or text.');
  }
  config.enabled = await yes('Enable capture and delivery?', current.public_key ? current.enabled : true);
  return validateConfig(config);
}
