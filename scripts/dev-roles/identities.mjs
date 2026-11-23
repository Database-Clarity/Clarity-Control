import { languages } from '../../packages/core/src/languageCodes.ts';

export function makeRoleChoices(config, projectIds) {
  const roles = new Map();
  const permissions = { users: { ...config.users }, partners: { ...config.partners } };
  let id = 8_000_000_000;
  function add(key, label, access, group) {
    while (Object.hasOwn(permissions.users, id) || Object.hasOwn(permissions.partners, id)) id++;
    const login = `local-${key}`;
    group[id] = { login, ...access };
    roles.set(key, { id, login, label });
    id++;
  }
  for (const role of ['maintainer', 'editor', 'trial']) {
    add(role, role[0].toUpperCase() + role.slice(1), { role }, permissions.users);
  }
  for (const lang of languages.filter((code) => code !== 'en')) {
    add(
      `translator-${lang}`,
      `Translator (${lang})`,
      { role: 'translator', languages: [lang] },
      permissions.users,
    );
    add(
      `manager-${lang}`,
      `Translation manager (${lang})`,
      { role: 'translator', languages: [lang], manages: [lang] },
      permissions.users,
    );
  }
  // There may be no configured export projects on the fetched ref. Keep a partner
  // identity for access checks without inventing a project in the copied data.
  add(
    'partner',
    'Partner',
    { projects: projectIds.length ? projectIds.slice(0, 40) : ['local-project'] },
    permissions.partners,
  );
  return { permissions, roles };
}
