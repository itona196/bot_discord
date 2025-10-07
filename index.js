import dotenv from "dotenv";
dotenv.config();

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder
} from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
  console.error(" Mets DISCORD_TOKEN et CLIENT_ID dans .env");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const SUITS = ["♠️", "♥️", "♦️", "♣️"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function createDeck() {
  const deck = [];
  for (const s of SUITS)
    for (const r of RANKS)
      deck.push({ rank: r, suit: s, code: `${r}${s}` });
  return shuffle(deck);
}

function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function draw(deck){ return deck.pop(); }
function renderHand(h){ return h.map(c => c.code).join(" "); }

function handValue(hand){
  let sum = 0, aces = 0;
  for(const c of hand){
    if(c.rank === "A"){ aces++; sum+=11; }
    else if(["J","Q","K"].includes(c.rank)) sum+=10;
    else sum += Number(c.rank);
  }
  while(sum>21 && aces>0){ sum-=10; aces--; }
  return sum;
}

function isBlackjack(hand){ return hand.length===2 && handValue(hand)===21; }

const games = new Map();

function newGame(userId){
  const deck = createDeck();
  const player = [draw(deck), draw(deck)];
  const dealer = [draw(deck), draw(deck)];
  const state = { deck, player, dealer, doubled:false, finished:false, createdAt: Date.now() };
  games.set(userId, state);
  return state;
}

function endGame(userId){ games.delete(userId); }

function actionRowFor(userId, disabled=false, canDouble=true){
  const hit = new ButtonBuilder()
    .setCustomId(`bj_hit:${userId}`)
    .setLabel("Hit")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(disabled);

  const stand = new ButtonBuilder()
    .setCustomId(`bj_stand:${userId}`)
    .setLabel("Stand")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  const dbl = new ButtonBuilder()
    .setCustomId(`bj_double:${userId}`)
    .setLabel("Double")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(disabled || !canDouble);

  return [ new ActionRowBuilder().addComponents(hit, stand, dbl) ];
}

function gameEmbedFor(state, user, reveal=false){
  const pVal = handValue(state.player);
  const dealerDisplay = reveal
    ? `${renderHand(state.dealer)}\n**Valeur :** ${handValue(state.dealer)}`
    : `${state.dealer[0].code} ?`;

  return new EmbedBuilder()
    .setTitle(`🃏 Blackjack — ${user.username}`)
    .addFields(
      { name: "Ta main", value: `${renderHand(state.player)}\n**Valeur :** ${pVal}`, inline:false },
      { name: "Main du croupier", value: dealerDisplay, inline:false }
    )
    .setFooter({ text: state.finished ? "Partie terminée" : "Choisis : Hit / Stand / Double" });
}

function dealerPlay(state){
  while(handValue(state.dealer) < 17) state.dealer.push(draw(state.deck));
}

function resolveState(state){
  const p = handValue(state.player);
  const d = handValue(state.dealer);
  if (isBlackjack(state.player) && !isBlackjack(state.dealer)) return { result:"blackjack", text:"Blackjack ! Tu gagnes 3:2." };
  if (isBlackjack(state.dealer) && !isBlackjack(state.player)) return { result:"lose", text:"Le croupier a Blackjack. Tu perds." };
  if (p>21) return { result:"bust", text:"Busted ! Tu perds." };
  if (d>21) return { result:"win", text:"Le croupier bust — tu gagnes !" };
  if (p> d) return { result:"win", text:"Tu gagnes !" };
  if (p === d) return { result:"push", text:"Égalité (Push)." };
  return { result:"lose", text:"Tu perds." };
}

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Répond pong").toJSON(),
  new SlashCommandBuilder().setName("blackjack").setDescription("Démarre une partie de Blackjack").toJSON()
];

const rest = new REST({ version: "10" }).setToken(token);

async function registerCommands(){
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("✅ Commandes enregistrées globalement (visible sur tous les serveurs, peut prendre ~1h).");
  } catch(e){
    console.error("Erreur commandes:", e);
  }
}

client.once("ready", () => console.log(`🤖 Connecté en tant que ${client.user.tag}`));

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isCommand()) {
      if (interaction.commandName === "ping") {
        const sent = await interaction.reply({ content: "Pong", fetchReply: true });
        const latency = sent.createdTimestamp - interaction.createdTimestamp;
        await interaction.editReply(`Pong ! Latence : ${latency} ms`);
      } else if (interaction.commandName === "blackjack") {
        const userId = interaction.user.id;
        if (games.has(userId)) {
          return interaction.reply({ content: "Tu as déjà une partie en cours. Termine-la d'abord.", ephemeral: true });
        }
        const state = newGame(userId);
        if (isBlackjack(state.player)) {
          state.finished = true;
          dealerPlay(state);
          const res = resolveState(state);
          await interaction.reply({
            embeds: [gameEmbedFor(state, interaction.user, true)],
            content: `Résultat : ${res.text}`
          });
          endGame(userId);
          return;
        }
        await interaction.reply({
          embeds: [gameEmbedFor(state, interaction.user, false)],
          components: actionRowFor(userId),
          ephemeral: false
        });
      }
    }

    if (interaction.isButton()) {
      const [prefix, userId] = interaction.customId.split(":");
      if (!userId || !games.has(userId)) {
        return interaction.reply({ content: "Partie introuvable ou expirée.", ephemeral: true });
      }
      if (interaction.user.id !== userId) {
        return interaction.reply({ content: "Ces boutons ne sont pas pour toi.", ephemeral: true });
      }

      const state = games.get(userId);
      if (state.finished) {
        return interaction.reply({ content: "La partie est déjà terminée.", ephemeral: true });
      }

      if (prefix === "bj_hit") {
        state.player.push(draw(state.deck));
        if (handValue(state.player) > 21) {
          state.finished = true;
          dealerPlay(state);
          const res = resolveState(state);
          await interaction.update({
            embeds: [gameEmbedFor(state, interaction.user, true)],
            components: actionRowFor(userId, true),
            content: `Résultat : ${res.text}`
          });
          endGame(userId);
          return;
        }
        await interaction.update({
          embeds: [gameEmbedFor(state, interaction.user, false)],
          components: actionRowFor(userId, false)
        });
        return;
      }

      if (prefix === "bj_stand") {
        state.finished = true;
        dealerPlay(state);
        const res = resolveState(state);
        await interaction.update({
          embeds: [gameEmbedFor(state, interaction.user, true)],
          components: actionRowFor(userId, true),
          content: `Résultat : ${res.text}`
        });
        endGame(userId);
        return;
      }

      if (prefix === "bj_double") {
        state.doubled = true;
        state.player.push(draw(state.deck));
        state.finished = true;
        dealerPlay(state);
        const res = resolveState(state);
        await interaction.update({
          embeds: [gameEmbedFor(state, interaction.user, true)],
          components: actionRowFor(userId, true),
          content: `Résultat (double) : ${res.text}`
        });
        endGame(userId);
        return;
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);
    if (interaction.replied || interaction.deferred) {
      try { await interaction.followUp({ content: "Erreur lors de l'interaction.", ephemeral: true }); } catch {}
    } else {
      try { await interaction.reply({ content: "Erreur lors de l'interaction.", ephemeral: true }); } catch {}
    }
  }
});

(async () => {
  await registerCommands();
  await client.login(token);
})();
