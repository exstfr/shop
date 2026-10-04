// ============================================================
//  Bot Discord - discord.js v14 - Node 18+
//  Lancer :  TOKEN=xxx STAFF_ROLE_ID=xxx SLOT_CATEGORY_ID=xxx node index.js
// ============================================================
const fs = require('fs');
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionFlagsBits,
  ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, AttachmentBuilder,
  ApplicationCommandOptionType,
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const PREFIX = '+';
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || '';
const SLOT_CATEGORY_ID = process.env.SLOT_CATEGORY_ID || null;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null;
const DB_FILE = './data.json';

// ---------- Stockage JSON ----------
let db = { warns: {}, mutes: {}, crypto: {}, antispam: {}, giveaways: {}, slots: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

// ---------- Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

// ---------- Utilitaires ----------
const P = PermissionFlagsBits;
const color = 0x3498db;
const emb = (desc, title) => {
  const e = new EmbedBuilder().setColor(color).setDescription(desc);
  if (title) e.setTitle(title);
  return e;
};
const parseDuration = (s) => {
  const m = /^(\d+)([smhdw])$/i.exec(s || '');
  if (!m) return null;
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2].toLowerCase()];
  return parseInt(m[1]) * mult;
};
const fmtDur = (ms) => {
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4);
  return [d && `${d}j`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '<1m';
};
const isStaff = (member) =>
  member.permissions.has(P.Administrator) || (STAFF_ROLE_ID && member.roles.cache.has(STAFF_ROLE_ID));

async function resolveUser(message, arg) {
  const m = message.mentions.users.first();
  if (m) return m;
  const id = (arg || '').replace(/\D/g, '');
  if (!id) return null;
  return client.users.fetch(id).catch(() => null);
}
async function resolveMember(message, arg) {
  const u = await resolveUser(message, arg);
  if (!u) return null;
  return message.guild.members.fetch(u.id).catch(() => null);
}

// Permission requise par commande
const NEED = {
  bl: P.BanMembers, unbl: P.BanMembers, warn: P.ModerateMembers, unwarn: P.ModerateMembers,
  mute: P.ModerateMembers, mutelist: P.ModerateMembers, unmute: P.ModerateMembers,
  clear: P.ManageMessages, renew: P.ManageChannels, lock: P.ManageChannels,
  unlock: P.ManageChannels, antispam: P.ManageGuild, slot: P.Administrator,
  addrole: P.ManageRoles, embedticket: P.ManageGuild, gw: P.ManageGuild,
  reroll: P.ManageGuild, say: P.ManageMessages, ez: P.ManageMessages,
  mp: P.ManageMessages, embed: P.ManageMessages,
};

// ---------- Crypto ----------
const COINS = { ltc: 'Litecoin', btc: 'Bitcoin', eth: 'Ethereum' };
async function getBalance(coin, addr) {
  const r = await fetch(`https://api.blockcypher.com/v1/${coin}/main/addrs/${addr}/balance`);
  if (!r.ok) throw new Error('API ' + r.status);
  const j = await r.json();
  const div = coin === 'eth' ? 1e18 : 1e8;
  return { bal: j.balance / div, unconf: j.unconfirmed_balance / div };
}

// ---------- Anti-spam ----------
const spamMap = new Map();
function checkSpam(message) {
  if (!db.antispam[message.channel.id] || isStaff(message.member)) return;
  const key = message.author.id + message.channel.id;
  const now = Date.now();
  const arr = (spamMap.get(key) || []).filter((t) => now - t < 5000);
  arr.push(now);
  spamMap.set(key, arr);
  if (arr.length >= 6) {
    spamMap.delete(key);
    message.member.timeout(60_000, 'Anti-spam').catch(() => {});
    message.channel.send({ embeds: [emb(`🚫 ${message.author} a été mute 1 min (spam).`)] }).catch(() => {});
  }
}

// ---------- Transcript ----------
async function buildTranscript(channel) {
  let all = [], before;
  for (let i = 0; i < 10; i++) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
  }
  all.reverse();
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = all.map((m) =>
    `<div style="margin:6px 0"><b>${esc(m.author.tag)}</b> <small>${m.createdAt.toLocaleString('fr-FR')}</small><br>${esc(m.content)}${
      m.attachments.map((a) => `<br><a href="${a.url}">${esc(a.name)}</a>`).join('')}</div>`).join('');
  return Buffer.from(`<html><meta charset="utf-8"><body style="background:#2b2d31;color:#ddd;font-family:sans-serif"><h2>Transcript #${esc(channel.name)}</h2>${rows}</body></html>`);
}

// ---------- Giveaways ----------
function scheduleGiveaway(g) {
  const delay = Math.max(g.end - Date.now(), 0);
  setTimeout(() => endGiveaway(g.messageId), Math.min(delay, 2 ** 31 - 1));
}
async function pickWinners(g, count) {
  const ch = await client.channels.fetch(g.channelId).catch(() => null);
  const msg = ch && await ch.messages.fetch(g.messageId).catch(() => null);
  if (!msg) return null;
  const reaction = msg.reactions.cache.find((r) => r.emoji.toString() === g.emoji || r.emoji.name === g.emoji);
  if (!reaction) return { ch, msg, winners: [] };
  const users = (await reaction.users.fetch()).filter((u) => !u.bot).map((u) => u.id);
  const winners = users.sort(() => Math.random() - 0.5).slice(0, count);
  return { ch, msg, winners };
}
async function endGiveaway(id) {
  const g = db.giveaways[id];
  if (!g || g.ended) return;
  const res = await pickWinners(g, g.winners);
  if (!res) return;
  g.ended = true; save();
  const txt = res.winners.length ? res.winners.map((w) => `<@${w}>`).join(', ') : 'Aucun participant';
  await res.msg.edit({ embeds: [emb(`**Gagnant(s) :** ${txt}`, `🎉 ${g.title} (terminé)`)] }).catch(() => {});
  res.ch.send(`🎉 Giveaway **${g.title}** terminé ! Gagnant(s) : ${txt}`).catch(() => {});
}

// ---------- Slots : expiration ----------
setInterval(async () => {
  for (const [chId, s] of Object.entries(db.slots)) {
    if (s.expired || Date.now() < s.end) continue;
    s.expired = true; save();
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch) continue;
    await ch.permissionOverwrites.edit(s.userId, { SendMessages: false }).catch(() => {});
    ch.send({ embeds: [emb(`⏰ Le slot de <@${s.userId}> a expiré.`)] }).catch(() => {});
  }
}, 60_000);

// ---------- Ready ----------
client.once('ready', async () => {
  console.log(`Connecté en tant que ${client.user.tag}`);
  // Slash command /dmall (réservée aux administrateurs)
  await client.application.commands.create({
    name: 'dmall',
    description: 'Envoie un MP (avec ping) à tous les membres du serveur',
    options: [{
      name: 'texte',
      description: 'Le texte à envoyer à tout le monde',
      type: ApplicationCommandOptionType.String,
      required: true,
    }],
    defaultMemberPermissions: PermissionFlagsBits.Administrator.toString(),
    dmPermission: false,
  }).catch((e) => console.error('Erreur enregistrement /dmall :', e));
  for (const g of Object.values(db.giveaways)) if (!g.ended) scheduleGiveaway(g);
});

// ---------- Commandes ----------
const COMMANDS = {
  // ===== MODÉRATION =====
  async bl(message, args) {
    if (!args.length) {
      const bans = await message.guild.bans.fetch();
      const list = bans.map((b) => `\`${b.user.id}\` • ${b.user.tag} — ${b.reason || 'Aucune raison'}`).slice(0, 40).join('\n');
      return message.reply({ embeds: [emb(list || 'Aucun banni.', '🔨 Liste des bannis')] });
    }
    const user = await resolveUser(message, args[0]);
    if (!user) return message.reply('Utilisateur introuvable.');
    const reason = args.slice(1).join(' ') || 'Aucune raison';
    await message.guild.members.ban(user.id, { reason }).catch((e) => message.reply('Erreur : ' + e.message));
    message.reply({ embeds: [emb(`🔨 **${user.tag}** a été banni.\nRaison : ${reason}`)] });
  },
  async unbl(message, args) {
    if (!args[0]) return message.reply('Usage : `+unbl <id>`');
    await message.guild.members.unban(args[0]).then(
      () => message.reply({ embeds: [emb(`✅ \`${args[0]}\` a été débanni.`)] }),
      () => message.reply('ID invalide ou non banni.'));
  },
  async warn(message, args) {
    const user = await resolveUser(message, args[0]);
    if (!user) return message.reply('Usage : `+warn <@user> [raison]`');
    const reason = args.slice(1).join(' ') || 'Aucune raison';
    (db.warns[user.id] ||= []).push({ reason, by: message.author.id, at: Date.now() });
    save();
    message.reply({ embeds: [emb(`⚠️ ${user} averti (${db.warns[user.id].length} warn).\nRaison : ${reason}`)] });
  },
  async unwarn(message, args) {
    const user = await resolveUser(message, args[0]);
    if (!user) return message.reply('Usage : `+unwarn <@user>`');
    if (!db.warns[user.id]?.length) return message.reply('Aucun avertissement.');
    db.warns[user.id].pop(); save();
    message.reply({ embeds: [emb(`✅ Un avertissement retiré à ${user} (reste ${db.warns[user.id].length}).`)] });
  },
  async mute(message, args) {
    const member = await resolveMember(message, args[0]);
    const dur = parseDuration(args[1]);
    if (!member || !dur) return message.reply('Usage : `+mute <@user/id> <durée> [raison]` (ex: 10m, 1h, 1d)');
    if (dur > 28 * 864e5) return message.reply('Durée max : 28 jours.');
    const reason = args.slice(2).join(' ') || 'Aucune raison';
    await member.timeout(dur, reason).catch((e) => message.reply('Erreur : ' + e.message));
    (db.mutes[member.id] ||= []).push({ reason, duration: dur, by: message.author.id, at: Date.now() });
    save();
    message.reply({ embeds: [emb(`🔇 ${member} mute pendant **${fmtDur(dur)}**.\nRaison : ${reason}`)] });
  },
  async mutelist(message, args) {
    const user = await resolveUser(message, args[0]);
    if (!user) return message.reply('Usage : `+mutelist <id>`');
    const list = (db.mutes[user.id] || []).map((m, i) =>
      `**${i + 1}.** <t:${Math.floor(m.at / 1000)}:f> • ${fmtDur(m.duration)} • ${m.reason} (par <@${m.by}>)`).join('\n');
    message.reply({ embeds: [emb(list || 'Aucun mute.', `📜 Mutes de ${user.tag}`)] });
  },
  async unmute(message, args) {
    const member = await resolveMember(message, args[0]);
    if (!member) return message.reply('Usage : `+unmute <@user/id>`');
    await member.timeout(null).catch(() => {});
    message.reply({ embeds: [emb(`🔊 ${member} n'est plus mute.`)] });
  },
  async clear(message, args) {
    let n = parseInt(args[0]);
    if (!n || n < 1) return message.reply('Usage : `+clear <nombre>` (max 200)');
    n = Math.min(n, 200);
    await message.delete().catch(() => {});
    let left = n;
    while (left > 0) {
      const del = await message.channel.bulkDelete(Math.min(left, 100), true).catch(() => null);
      if (!del || !del.size) break;
      left -= del.size;
    }
    const m = await message.channel.send({ embeds: [emb(`🧹 ${n - left} message(s) supprimé(s).`)] });
    setTimeout(() => m.delete().catch(() => {}), 3000);
  },
  async renew(message) {
    const ch = message.channel;
    const clone = await ch.clone();
    await clone.setPosition(ch.position);
    await ch.delete();
    clone.send({ embeds: [emb('🔄 Salon réinitialisé.')] });
  },
  async lock(message) {
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
    message.reply({ embeds: [emb('🔒 Salon verrouillé.')] });
  },
  async unlock(message) {
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
    message.reply({ embeds: [emb('🔓 Salon déverrouillé.')] });
  },
  async antispam(message, args) {
    const v = (args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(v)) return message.reply('Usage : `+antispam <on/off>`');
    if (v === 'on') db.antispam[message.channel.id] = true; else delete db.antispam[message.channel.id];
    save();
    message.reply({ embeds: [emb(`🛡️ Anti-spam **${v}** dans ce salon.`)] });
  },

  // ===== PAIEMENTS & CRYPTO =====
  async tos(message) {
    const c = db.crypto[message.author.id] || {};
    const txt = Object.keys(COINS).map((k) => `**${k.toUpperCase()}** : ${c[k] ? `\`${c[k]}\`` : '*non configurée*'}`).join('\n');
    message.reply({ embeds: [emb(txt, '💰 Tes adresses de paiement')] });
  },
  async tosconfig(message) {
    const row = new ActionRowBuilder().addComponents(
      ...Object.keys(COINS).map((k) =>
        new ButtonBuilder().setCustomId(`tos_${k}_${message.author.id}`).setLabel(k.toUpperCase()).setStyle(ButtonStyle.Primary)));
    message.reply({ embeds: [emb('Clique sur une crypto pour configurer ton adresse.', '⚙️ Configuration paiements')], components: [row] });
  },
  async setltc(m, a) { return setAddr(m, a, 'ltc'); },
  async setbtc(m, a) { return setAddr(m, a, 'btc'); },
  async seteth(m, a) { return setAddr(m, a, 'eth'); },
  async ltc(m) { return showAddr(m, 'ltc'); },
  async btc(m) { return showAddr(m, 'btc'); },
  async eth(m) { return showAddr(m, 'eth'); },
  async mybal(message, args) {
    const c = db.crypto[message.author.id] || {};
    const coins = args[0] ? [args[0].toLowerCase()] : Object.keys(COINS).filter((k) => c[k]);
    if (!coins.length) return message.reply('Aucune adresse configurée.');
    const lines = [];
    for (const k of coins) {
      if (!COINS[k]) return message.reply('Crypto : ltc, btc ou eth.');
      if (!c[k]) { lines.push(`**${k.toUpperCase()}** : adresse non configurée`); continue; }
      try {
        const { bal, unconf } = await getBalance(k, c[k]);
        lines.push(`**${k.toUpperCase()}** : \`${bal}\`${unconf ? ` (+${unconf} en attente)` : ''}`);
      } catch (e) { lines.push(`**${k.toUpperCase()}** : erreur API (${e.message})`); }
    }
    message.reply({ embeds: [emb(lines.join('\n'), '💳 Solde')] });
  },

  // ===== TICKETS, SLOTS & RÔLES =====
  async slot(message, args) {
    const member = await resolveMember(message, args[0]);
    const tier = args[1], period = (args[2] || '').toLowerCase();
    if (!member || !['1', '2'].includes(tier) || !['weekly', 'monthly'].includes(period))
      return message.reply('Usage : `+slot <@user> <1|2> <weekly|monthly>`');
    const dur = period === 'weekly' ? 7 * 864e5 : 30 * 864e5;
    const ch = await message.guild.channels.create({
      name: `slot${tier}-${member.user.username}`,
      type: ChannelType.GuildText,
      parent: SLOT_CATEGORY_ID,
      topic: `Slot ${tier} • ${period} • <@${member.id}>`,
      permissionOverwrites: [
        { id: message.guild.roles.everyone, allow: [P.ViewChannel], deny: [P.SendMessages] },
        { id: member.id, allow: [P.ViewChannel, P.SendMessages, P.AttachFiles, P.EmbedLinks] },
      ],
    });
    db.slots[ch.id] = { userId: member.id, tier, period, end: Date.now() + dur }; save();
    message.reply({ embeds: [emb(`✅ Slot **${tier}** (${period}) créé pour ${member} : ${ch}\nExpire <t:${Math.floor((Date.now() + dur) / 1000)}:R>`)] });
  },
  async addrole(message, args) {
    const role = message.mentions.roles.first();
    const member = await resolveMember(message, args[1]);
    if (!role || !member) return message.reply('Usage : `+addrole <@role> <@user>`');
    await member.roles.add(role).then(
      () => message.reply({ embeds: [emb(`✅ ${role} donné à ${member}.`)] }),
      (e) => message.reply('Erreur : ' + e.message));
  },
  async embedticket(message, args) {
    const parts = args.join(' ').split('|').map((s) => s.trim());
    if (parts.length < 3) return message.reply('Usage : `+embedticket <Titre> | <Desc> | <Option1/emoji/key> | ...`');
    const [title, desc, ...opts] = parts;
    const options = opts.map((o) => {
      const [label, emoji, key] = o.split('/').map((s) => s.trim());
      const opt = { label: label || 'Option', value: key || label || 'option' };
      if (emoji) opt.emoji = emoji;
      return opt;
    }).slice(0, 25);
    const menu = new StringSelectMenuBuilder().setCustomId('ticket_select').setPlaceholder('Choisis une catégorie').addOptions(options);
    await message.delete().catch(() => {});
    message.channel.send({ embeds: [emb(desc, title)], components: [new ActionRowBuilder().addComponents(menu)] });
  },
  async claim(message) {
    const ch = message.channel;
    if (!ch.topic?.startsWith('ticket:')) return message.reply('Pas un ticket.');
    if (ch.topic.includes('claimed:')) return message.reply('Déjà réclamé.');
    await ch.setTopic(`${ch.topic}|claimed:${message.author.id}`);
    message.reply({ embeds: [emb(`🙋 Ticket pris en charge par ${message.author}.`)] });
  },
  async unclaim(message) {
    const ch = message.channel;
    if (!ch.topic?.includes('claimed:')) return message.reply('Ticket non réclamé.');
    await ch.setTopic(ch.topic.replace(/\|claimed:\d+/, ''));
    message.reply({ embeds: [emb('🔓 Ticket libéré.')] });
  },
  async close(message) {
    const ch = message.channel;
    if (!ch.topic?.startsWith('ticket:')) return message.reply('Pas un ticket.');
    const openerId = ch.topic.split('|')[0].slice(7);
    await message.reply({ embeds: [emb('🔒 Fermeture du ticket...')] });
    const file = new AttachmentBuilder(await buildTranscript(ch), { name: `transcript-${ch.name}.html` });
    const opener = await client.users.fetch(openerId).catch(() => null);
    if (opener) await opener.send({ content: `Transcript de ton ticket **${ch.name}**`, files: [file] }).catch(() => {});
    setTimeout(() => ch.delete().catch(() => {}), 3000);
  },

  // ===== GIVEAWAYS =====
  async gw(message, args) {
    const p = args.join(' ').split('|').map((s) => s.trim());
    if (p.length < 4) return message.reply('Usage : `+gw <Titre> | <Desc> | <Temps> | <Gagnants> | [Emoji]`');
    const [title, desc, time, win, emoji = '🎉'] = p;
    const dur = parseDuration(time), winners = parseInt(win);
    if (!dur || !winners) return message.reply('Temps (ex: 1h, 2d) ou nombre de gagnants invalide.');
    const end = Date.now() + dur;
    const msg = await message.channel.send({
      embeds: [emb(`${desc}\n\nRéagis avec ${emoji} pour participer !\n**Gagnants :** ${winners}\n**Fin :** <t:${Math.floor(end / 1000)}:R>`, `🎉 ${title}`)],
    });
    await msg.react(emoji).catch(() => message.reply('Emoji invalide.'));
    const g = { messageId: msg.id, channelId: msg.channel.id, title, end, winners, emoji, ended: false };
    db.giveaways[msg.id] = g; save();
    scheduleGiveaway(g);
    message.delete().catch(() => {});
  },
  async reroll(message, args) {
    const g = db.giveaways[args[0]];
    if (!g) return message.reply('Usage : `+reroll <id_message> [gagnants]` (giveaway introuvable)');
    const res = await pickWinners(g, parseInt(args[1]) || 1);
    if (!res || !res.winners.length) return message.reply('Aucun participant.');
    message.channel.send(`🎉 Nouveau(x) gagnant(s) : ${res.winners.map((w) => `<@${w}>`).join(', ')}`);
  },

  // ===== UTILITAIRES & MESSAGES =====
  async pic(message, args) {
    const user = (await resolveUser(message, args[0])) || message.author;
    const url = user.displayAvatarURL({ size: 4096, extension: 'png' });
    message.reply({ embeds: [new EmbedBuilder().setColor(color).setTitle(`Avatar de ${user.tag}`).setImage(url)] });
  },
  async embed(message, args) {
    if (!args.length) return message.reply('Usage : `+embed <texte>`');
    await message.delete().catch(() => {});
    message.channel.send({ embeds: [emb(args.join(' '))] });
  },
  async say(message, args) {
    if (!args.length) return;
    await message.delete().catch(() => {});
    message.channel.send({ content: args.join(' '), allowedMentions: { parse: [] } });
  },
  async ez(message, args) {
    let n = 1;
    if (args.length > 1 && /^\d+$/.test(args[args.length - 1])) n = parseInt(args.pop());
    n = Math.min(n, 20);
    const text = args.join(' ');
    if (!text) return message.reply('Usage : `+ez <message> [nombre]`');
    for (let i = 0; i < n; i++) await message.channel.send({ content: text, allowedMentions: { parse: [] } });
  },
  async mp(message, args) {
    const user = await resolveUser(message, args[0]);
    const text = args.slice(1).join(' ');
    if (!user || !text) return message.reply('Usage : `+mp <@user/id> <message>`');
    await user.send(text).then(
      () => message.reply({ embeds: [emb(`✉️ Message envoyé à ${user.tag}.`)] }),
      () => message.reply('Impossible d\'envoyer le MP (fermés ?).'));
  },
};

async function setAddr(message, args, coin) {
  if (!args[0]) return message.reply(`Usage : \`+set${coin} <adresse>\``);
  (db.crypto[message.author.id] ||= {})[coin] = args[0]; save();
  message.delete().catch(() => {});
  message.channel.send({ embeds: [emb(`✅ Adresse **${coin.toUpperCase()}** enregistrée.`)] });
}
async function showAddr(message, coin) {
  const a = db.crypto[message.author.id]?.[coin];
  message.reply(a ? `**${coin.toUpperCase()}** : ${a}` : `Aucune adresse ${coin.toUpperCase()} configurée (\`+set${coin} <adresse>\`).`);
}

// ---------- Handler messages ----------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  checkSpam(message);
  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const name = args.shift().toLowerCase();
  const cmd = COMMANDS[name];
  if (!cmd) return;
  const member = message.member;
  if (NEED[name] && !member.permissions.has(NEED[name]) && !isStaff(member))
    return message.reply('❌ Permission insuffisante.');
  try { await cmd(message, args); }
  catch (e) { console.error(e); message.reply('❌ Erreur : ' + e.message).catch(() => {}); }
});

// ---------- Interactions (tickets, tosconfig) ----------
client.on('interactionCreate', async (i) => {
  try {
    // Slash command /dmall
    if (i.isChatInputCommand() && i.commandName === 'dmall') {
      if (!i.inGuild() || !i.memberPermissions.has(P.Administrator))
        return i.reply({ content: '❌ Permission insuffisante.', ephemeral: true });
      const texte = i.options.getString('texte', true);
      await i.deferReply({ ephemeral: true });

      const members = await i.guild.members.fetch();
      const targets = members.filter((m) => !m.user.bot);
      let ok = 0, fail = 0, done = 0;
      await i.editReply(`📨 Envoi en cours à ${targets.size} membres...`);

      for (const m of targets.values()) {
        try {
          // <@id> = ping de l'utilisateur dans le MP
          await m.send({ content: `${m.user} ${texte}`, allowedMentions: { users: [m.id] } });
          ok++;
        } catch { fail++; } // MP fermés, etc.
        done++;
        if (done % 25 === 0) i.editReply(`📨 Progression : ${done}/${targets.size}`).catch(() => {});
        await new Promise((r) => setTimeout(r, 1500)); // délai anti rate-limit
      }
      return i.editReply({ embeds: [emb(`✅ Envoyés : **${ok}**\n❌ Échecs (MP fermés) : **${fail}**`, 'DMAll terminé')] });
    }
    // Menu tickets
    if (i.isStringSelectMenu() && i.customId === 'ticket_select') {
      const key = i.values[0];
      const existing = i.guild.channels.cache.find((c) => c.topic?.startsWith(`ticket:${i.user.id}`));
      if (existing) return i.reply({ content: `Tu as déjà un ticket : ${existing}`, ephemeral: true });
      const overwrites = [
        { id: i.guild.roles.everyone, deny: [P.ViewChannel] },
        { id: i.user.id, allow: [P.ViewChannel, P.SendMessages, P.AttachFiles] },
      ];
      if (STAFF_ROLE_ID) overwrites.push({ id: STAFF_ROLE_ID, allow: [P.ViewChannel, P.SendMessages, P.ManageMessages] });
      const ch = await i.guild.channels.create({
        name: `${key}-${i.user.username}`.slice(0, 90),
        type: ChannelType.GuildText,
        parent: TICKET_CATEGORY_ID,
        topic: `ticket:${i.user.id}`,
        permissionOverwrites: overwrites,
      });
      await ch.send({ content: `${i.user}${STAFF_ROLE_ID ? ` <@&${STAFF_ROLE_ID}>` : ''}`,
        embeds: [emb(`Ticket **${key}** ouvert.\nUn membre du staff va te répondre.\n\`+claim\` • \`+unclaim\` • \`+close\``)] });
      return i.reply({ content: `✅ Ticket créé : ${ch}`, ephemeral: true });
    }
    // Bouton tosconfig
    if (i.isButton() && i.customId.startsWith('tos_')) {
      const [, coin, uid] = i.customId.split('_');
      if (i.user.id !== uid) return i.reply({ content: 'Ce panneau n\'est pas à toi.', ephemeral: true });
      const modal = new ModalBuilder().setCustomId(`tosm_${coin}`).setTitle(`Adresse ${coin.toUpperCase()}`)
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('addr').setLabel('Adresse').setStyle(TextInputStyle.Short).setRequired(true)));
      return i.showModal(modal);
    }
    // Modal tosconfig
    if (i.isModalSubmit() && i.customId.startsWith('tosm_')) {
      const coin = i.customId.split('_')[1];
      (db.crypto[i.user.id] ||= {})[coin] = i.fields.getTextInputValue('addr').trim(); save();
      return i.reply({ content: `✅ Adresse ${coin.toUpperCase()} enregistrée.`, ephemeral: true });
    }
  } catch (e) {
    console.error(e);
    if (!i.replied && !i.deferred) i.reply({ content: 'Erreur.', ephemeral: true }).catch(() => {});
  }
});

process.on('unhandledRejection', (e) => console.error(e));
client.login(TOKEN);
