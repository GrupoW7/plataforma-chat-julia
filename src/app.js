const app = document.querySelector("#app");
const config = window.CHAT_APP_CONFIG || {};
const SESSION_KEY = "crm_julia_chat_user";
const ZAIA_MESSAGE_API_URL =
  "https://core-service.zaia.app/v1.1/api/message-cross-channel/create";
const ZAIA_AGENT_ID = 70482;
const ZAIA_AUTH_TOKEN = "7ca346d9-0834-4559-b9ec-6eb8888320bd";

const state = {
  currentUser: null,
  stores: [],
  selectedStoreId: null,
  conversations: [],
  searchQuery: "",
  unreadByChat: {},
  messageCountByChat: {},
  activeConversation: null,
  messages: [],
  loading: true,
  realtimeChannel: null,
  refreshTimer: null,
  listRefreshTimer: null,
  lastInteractionAt: Date.now(),
  pendingSilentRefresh: false,
};

const supabaseConfigured = Boolean(
  config.SUPABASE_URL && config.SUPABASE_ANON_KEY
);
const supabase = supabaseConfigured
  ? createSupabaseRestClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY)
  : null;

function createSupabaseRestClient(url, apiKey) {
  const baseUrl = url.replace(/\/$/, "");

  return {
    async rpc(functionName, params) {
      try {
        const response = await fetch(`${baseUrl}/rest/v1/rpc/${functionName}`, {
          method: "POST",
          headers: {
            apikey: apiKey,
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(params || {}),
        });

        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;

        if (!response.ok) {
          return {
            data: null,
            error: {
              message: payload?.message || `Erro ${response.status} no Supabase`,
            },
          };
        }

        return { data: payload, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
    async removeChannel() {},
    channel() {
      return {
        on() {
          return this;
        },
        subscribe() {
          return this;
        },
      };
    },
  };
}

const formatTime = (value) => {
  if (!value) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
};

const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function render() {
  if (!supabaseConfigured) {
    app.innerHTML = renderMissingConfig();
    return;
  }

  if (state.loading) {
    app.innerHTML = `<main class="boot-screen"><span class="loader"></span></main>`;
    return;
  }

  app.innerHTML = state.currentUser ? renderWorkspace() : renderAuth();
  bindEvents();
  scrollMessagesToBottom();
}

function renderMissingConfig() {
  return `
    <main class="setup-screen">
      <section class="setup-panel">
        <p class="eyebrow">Configuracao pendente</p>
        <h1>Conecte seu projeto Supabase</h1>
        <p>Edite <code>src/config.js</code> com <code>SUPABASE_URL</code> e <code>SUPABASE_ANON_KEY</code>.</p>
      </section>
    </main>
  `;
}

function renderAuth() {
  return `
    <main class="auth-screen">
      <section class="auth-copy">
        <p class="eyebrow">Julia CRM</p>
        <h1>Central de atendimento WhatsApp em tempo real por loja.</h1>
        <p>Acesse com seu usuario da plataforma Julia para visualizar somente as lojas liberadas para o seu atendimento.</p>
      </section>

      <section class="auth-panel" aria-label="Formulario de acesso">
        <div>
          <h2>Entrar</h2>
          <p>Preencha os dados para acessar.</p>
        </div>

        <form id="auth-form" class="stack">
          <label>
            Email
            <input type="email" name="email" autocomplete="email" required />
          </label>
          <label>
            Senha
            <input type="password" name="password" autocomplete="current-password" required />
          </label>
          <button class="primary-button" type="submit">Entrar</button>
        </form>
      </section>
    </main>
  `;
}

function renderWorkspace() {
  return `
    <main class="workspace">
      <aside class="sidebar">
        <header class="sidebar-header">
          <div>
            <p class="eyebrow">Historico</p>
            <h1>Conversas</h1>
          </div>
        </header>

        ${renderStoreSelector()}

        <form id="chat-search-form" class="new-chat">
          <input name="search" value="${escapeHtml(state.searchQuery)}" placeholder="Buscar cliente" aria-label="Buscar cliente" ${state.selectedStoreId ? "" : "disabled"} />
          <button type="submit" title="Filtrar busca" aria-label="Filtrar busca" ${state.selectedStoreId ? "" : "disabled"}>Buscar</button>
        </form>

        <div class="conversation-list">
          ${renderConversationList()}
        </div>

        <button class="sign-out-button" id="sign-out" type="button">Sair</button>
      </aside>

      <section class="chat-panel">
        ${state.activeConversation ? renderChat() : renderEmptyChat()}
      </section>
    </main>
  `;
}

function renderStoreSelector() {
  if (!state.stores.length) {
    return `
      <div class="store-strip">
        <strong>Nenhuma loja liberada</strong>
        <span>Inclua o usuario em <code>usuarios_atendentes</code> para liberar um CNPJ.</span>
      </div>
    `;
  }

  return `
    <label class="store-selector">
      Loja
      <select id="store-selector" aria-label="Selecionar loja">
        ${state.stores
          .map((store) => {
            const cnpj = store.cnpj ? ` - ${store.cnpj}` : "";
            return `
              <option value="${store.id}" ${store.id === state.selectedStoreId ? "selected" : ""}>
                ${escapeHtml(`${store.nome || "Loja sem nome"}${cnpj}`)}
              </option>
            `;
          })
          .join("")}
      </select>
    </label>
  `;
}

function renderConversationList() {
  if (!state.stores.length) return "";

  const conversations = getFilteredConversations();

  if (!state.conversations.length) {
    return `
      <div class="empty-list">
        <strong>Nenhuma conversa</strong>
        <span>Esta loja ainda nao possui chats abertos.</span>
      </div>
    `;
  }

  if (!conversations.length) {
    return `
      <div class="empty-list">
        <strong>Nenhum resultado</strong>
        <span>Tente buscar por nome, telefone ou mensagem.</span>
      </div>
    `;
  }

  return conversations
    .map((conversation) => {
      const isActive = state.activeConversation?.id === conversation.id;
      const unreadCount = state.unreadByChat[getConversationKey(conversation)] || 0;
      const title = conversation.nomecliente || `Chat ${conversation.chat_id}`;
      const detail =
        conversation.ultimo_conteudo ||
        conversation.resumo ||
        conversation.telefone ||
        "Sem mensagens";

      return `
        <button class="conversation-item ${isActive ? "active" : ""}" data-conversation-id="${conversation.id}" type="button">
          <span class="avatar">${escapeHtml(title.slice(0, 1).toUpperCase())}</span>
          <span class="conversation-copy">
            <span class="conversation-topline">
              <strong>${escapeHtml(title)}</strong>
              <small>${formatTime(conversation.ultima_mensagem || conversation.data_inicio)}</small>
            </span>
            <span class="conversation-preview-row">
              <span class="conversation-preview">${escapeHtml(detail)}</span>
              ${unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : ""}
            </span>
          </span>
        </button>
      `;
    })
    .join("");
}

function getFilteredConversations() {
  const query = state.searchQuery.trim().toLowerCase();
  if (!query) return state.conversations;

  return state.conversations.filter((conversation) => {
    const searchable = [
      conversation.nomecliente,
      conversation.telefone,
      conversation.resumo,
      conversation.ultimo_conteudo,
      conversation.chat_id,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchable.includes(query);
  });
}

function renderChat() {
  const title =
    state.activeConversation.nomecliente ||
    `Chat ${state.activeConversation.chat_id}`;
  const store = state.stores.find((item) => item.id === state.selectedStoreId);
  const status = state.activeConversation.status_ativo ? "ativo" : "encerrado";

  return `
    <header class="chat-header">
      <span class="avatar large">${escapeHtml(title.slice(0, 1).toUpperCase())}</span>
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(`${store?.nome || "Loja"} - ${status}`)}</p>
      </div>
    </header>

    <div class="message-list" id="message-list">
      ${renderMessages()}
    </div>

    <form id="message-form" class="composer">
      <input name="message" placeholder="Digite uma mensagem" autocomplete="off" required />
      <button type="submit">Enviar</button>
    </form>
  `;
}

function renderMessages() {
  if (!state.messages.length) {
    return `<div class="empty-chat">Nenhuma mensagem ainda.</div>`;
  }

  return sortMessagesByDate(state.messages)
    .map((message) => {
      const mine = message.remetente_tipo === "atendente";
      return `
        <article class="message ${mine ? "mine" : "theirs"}">
          <p>${escapeHtml(message.conteudo || "")}</p>
          <time>${formatTime(message.criado_em)}</time>
        </article>
      `;
    })
    .join("");
}

function renderEmptyChat() {
  return `
    <div class="chat-placeholder">
      <div>
        <p class="eyebrow">Pronto para atender</p>
        <h2>Selecione uma conversa</h2>
        <p>Os chats aparecem conforme a loja escolhida. Cada CNPJ exibe apenas o historico liberado para seu usuario.</p>
      </div>
    </div>
  `;
}

function renderPreservingComposer() {
  const composerInput = document.querySelector("#message-form input");
  const wasFocused = document.activeElement === composerInput;
  const draft = composerInput?.value || "";

  render();

  const nextComposerInput = document.querySelector("#message-form input");
  if (nextComposerInput && draft) {
    nextComposerInput.value = draft;
    if (wasFocused) {
      nextComposerInput.focus();
      nextComposerInput.setSelectionRange(draft.length, draft.length);
    }
  }
}

function bindEvents() {
  document.querySelector("#auth-form")?.addEventListener("submit", handleAuth);
  document.querySelector("#sign-out")?.addEventListener("click", handleSignOut);
  document.querySelector("#store-selector")?.addEventListener("change", handleStoreChange);
  document.querySelector("#chat-search-form")?.addEventListener("submit", handleSearchChats);
  document.querySelector("#chat-search-form input")?.addEventListener("input", handleSearchInput);
  document.querySelector("#message-form")?.addEventListener("submit", handleSendMessage);
  document.querySelector(".workspace")?.addEventListener("pointerdown", markUserInteraction);
  document.querySelector(".workspace")?.addEventListener("keydown", markUserInteraction);
  document.querySelector(".message-list")?.addEventListener("scroll", markUserInteraction, {
    passive: true,
  });
  document.querySelector(".conversation-list")?.addEventListener("scroll", markUserInteraction, {
    passive: true,
  });

  document.querySelectorAll("[data-conversation-id]").forEach((button) => {
    button.addEventListener("click", () => selectConversation(button.dataset.conversationId));
  });
}

async function handleAuth(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const email = String(form.get("email") || "").trim();
  const password = String(form.get("password") || "");

  const { data, error } = await supabase.rpc("login_atendente", {
    p_email: email,
    p_password: password,
  });

  if (error) {
    showToast(error.message);
    return;
  }

  const user = data?.[0];
  if (!user) {
    showToast("Email, senha ou permissao de loja invalida.");
    return;
  }

  state.currentUser = user;
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  requestNotificationPermission();
  await loadInitialData();
}

async function handleSignOut() {
  if (state.realtimeChannel) {
    await supabase.removeChannel(state.realtimeChannel);
  }
  stopMessagePolling();
  stopConversationListPolling();
  localStorage.removeItem(SESSION_KEY);
  state.currentUser = null;
  state.stores = [];
  state.selectedStoreId = null;
  state.conversations = [];
  state.searchQuery = "";
  state.unreadByChat = {};
  state.messageCountByChat = {};
  state.activeConversation = null;
  state.messages = [];
  render();
}

function handleSearchChats(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  state.searchQuery = String(form.get("search") || "").trim();
  render();
}

function handleSearchInput(event) {
  markUserInteraction();
  state.searchQuery = event.currentTarget.value;
}

async function handleStoreChange(event) {
  stopMessagePolling();
  stopConversationListPolling();
  state.selectedStoreId = event.currentTarget.value;
  state.searchQuery = "";
  state.unreadByChat = {};
  state.messageCountByChat = {};
  state.activeConversation = null;
  state.messages = [];
  await loadConversations({ notify: false });
  if (state.conversations[0]) {
    await selectConversation(state.conversations[0].id, { silent: true });
  }
  startConversationListPolling();
  render();
}

async function handleSendMessage(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const attendantMessage = String(form.get("message") || "").trim();
  if (!attendantMessage || !state.activeConversation) return;

  const composerInput = event.currentTarget.querySelector('input[name="message"]');
  if (composerInput) composerInput.value = "";

  const zaiaError = await sendMessageToZaia(attendantMessage);
  if (zaiaError) {
    showToast(zaiaError);
    return;
  }

  const { data, error } = await supabase.rpc("enviar_mensagem_atendente", {
    p_session_token: state.currentUser.session_token,
    p_loja_id: state.selectedStoreId,
    p_chat_id: state.activeConversation.chat_id,
    p_conteudo: attendantMessage,
  });

  if (error) {
    showToast(error.message);
    return;
  }

  if (data?.[0]) state.messages = [...state.messages, data[0]];
  await loadConversations({ notify: false });
  syncActiveConversationFromList();
  render();
}

async function sendMessageToZaia(message) {
  const attendantMessage = String(message || "").trim();
  const phoneNumber = String(state.activeConversation.telefone || "").replace(
    /\D/g,
    ""
  );

  if (!phoneNumber) {
    return "O chat selecionado nao possui telefone do cliente.";
  }

  const chatId = Number(state.activeConversation.chat_id);
  const payload = {
    agentId: ZAIA_AGENT_ID,
    message: attendantMessage,
    whatsAppPhoneNumber: phoneNumber,
    externalGenerativeChatId: Number.isNaN(chatId)
      ? state.activeConversation.chat_id
      : chatId,
    channel: "whatsapp_business",
  };

  try {
    const response = await fetch(ZAIA_MESSAGE_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ZAIA_AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = await response.text();
      return detail || `Erro ${response.status} ao enviar mensagem na Zaia.`;
    }

    return null;
  } catch (error) {
    return error.message || "Nao foi possivel conectar na API da Zaia.";
  }
}

async function loadInitialData() {
  if (!supabase) {
    state.loading = false;
    render();
    return;
  }

  state.loading = true;
  render();

  if (!state.currentUser) {
    state.currentUser = readSavedUser();
  }

  if (state.currentUser) {
    requestNotificationPermission();
    await loadStores();
    await loadConversations({ notify: false });
    if (state.conversations[0]) {
      await selectConversation(state.conversations[0].id, { silent: true });
    }
    startConversationListPolling();
  }

  state.loading = false;
  render();
}

function readSavedUser() {
  try {
    const user = JSON.parse(localStorage.getItem(SESSION_KEY));
    return user?.session_token ? user : null;
  } catch {
    return null;
  }
}

async function loadStores() {
  const { data, error } = await supabase.rpc("lojas_do_atendente", {
    p_session_token: state.currentUser.session_token,
  });

  if (error) {
    showToast(error.message);
    return;
  }

  state.stores = data || [];
  state.selectedStoreId =
    state.selectedStoreId &&
    state.stores.some((store) => store.id === state.selectedStoreId)
      ? state.selectedStoreId
      : state.stores[0]?.id || null;
}

async function loadConversations(options = {}) {
  if (!state.selectedStoreId) {
    state.conversations = [];
    return;
  }

  const { data, error } = await supabase.rpc("historico_por_loja", {
    p_session_token: state.currentUser.session_token,
    p_loja_id: state.selectedStoreId,
  });

  if (error) {
    showToast(error.message);
    return;
  }

  const nextConversations = data || [];
  updateUnreadCounts(nextConversations, {
    notify: Boolean(options.notify),
  });
  state.conversations = nextConversations;
}

function updateUnreadCounts(conversations, options = {}) {
  const nextCounts = {};

  conversations.forEach((conversation) => {
    const key = getConversationKey(conversation);
    const nextCount = Number(conversation.total_mensagens || 0);
    const previousCount = state.messageCountByChat[key];
    const activeKey = state.activeConversation
      ? getConversationKey(state.activeConversation)
      : null;

    nextCounts[key] = nextCount;

    if (
      options.notify &&
      previousCount !== undefined &&
      nextCount > previousCount &&
      key !== activeKey
    ) {
      const newCount = nextCount - previousCount;
      notifyIncomingMessage(conversation, newCount);
      state.unreadByChat[key] = (state.unreadByChat[key] || 0) + newCount;
    }

    if (key === activeKey) {
      state.unreadByChat[key] = 0;
    }
  });

  state.messageCountByChat = nextCounts;
}

function getConversationKey(conversation) {
  return `${conversation.loja_id}:${conversation.chat_id}`;
}

function syncActiveConversationFromList() {
  if (!state.activeConversation) return;

  const updated = state.conversations.find(
    (conversation) =>
      conversation.chat_id === state.activeConversation.chat_id &&
      conversation.loja_id === state.activeConversation.loja_id
  );

  if (updated) {
    state.activeConversation = updated;
  }
}

async function selectConversation(conversationId, options = {}) {
  const conversation = state.conversations.find(
    (item) => item.id === conversationId && item.loja_id === state.selectedStoreId
  );

  if (!conversation) {
    showToast("Conversa indisponivel para a loja selecionada.");
    return;
  }

  state.activeConversation = conversation;
  state.unreadByChat[getConversationKey(conversation)] = 0;

  const { data, error } = await supabase.rpc("mensagens_da_conversa", {
    p_session_token: state.currentUser.session_token,
    p_loja_id: state.selectedStoreId,
    p_chat_id: conversation.chat_id,
  });

  if (error) {
    showToast(error.message);
    return;
  }

  state.messages = sortMessagesByDate(data || []);
  subscribeToMessages(conversation.chat_id);
  startMessagePolling();

  if (!options.silent) render();
}

function startMessagePolling() {
  stopMessagePolling();
  state.refreshTimer = setInterval(refreshActiveConversation, 5000);
}

function stopMessagePolling() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

async function refreshActiveConversation() {
  if (!state.activeConversation || !state.selectedStoreId || !state.currentUser) {
    return;
  }

  const { data, error } = await supabase.rpc("mensagens_da_conversa", {
    p_session_token: state.currentUser.session_token,
    p_loja_id: state.selectedStoreId,
    p_chat_id: state.activeConversation.chat_id,
  });

  if (error) return;

  const nextMessages = sortMessagesByDate(data || []);
  const previousIds = new Set(state.messages.map((message) => message.id));
  const newIncomingMessages = nextMessages.filter(
    (message) =>
      !previousIds.has(message.id) && message.remetente_tipo !== "atendente"
  );

  if (nextMessages.length !== state.messages.length) {
    state.messages = nextMessages;
    if (newIncomingMessages.length) {
      notifyIncomingMessage(state.activeConversation, newIncomingMessages.length);
    }
    await loadConversations({ notify: false });
    renderWhenIdle();
  }
}

function startConversationListPolling() {
  stopConversationListPolling();
  state.listRefreshTimer = setInterval(refreshConversationList, 5000);
}

function stopConversationListPolling() {
  if (state.listRefreshTimer) {
    clearInterval(state.listRefreshTimer);
    state.listRefreshTimer = null;
  }
}

async function refreshConversationList() {
  if (!state.currentUser || !state.selectedStoreId) return;
  await loadConversations({ notify: true });
  syncActiveConversationFromList();
  renderWhenIdle();
}

function markUserInteraction() {
  state.lastInteractionAt = Date.now();
}

function isUserInteracting() {
  return Date.now() - state.lastInteractionAt < 2500;
}

function renderWhenIdle() {
  if (isUserInteracting()) {
    state.pendingSilentRefresh = true;
    window.clearTimeout(renderWhenIdle.timeoutId);
    renderWhenIdle.timeoutId = window.setTimeout(() => {
      if (!isUserInteracting() && state.pendingSilentRefresh) {
        state.pendingSilentRefresh = false;
        renderPreservingComposer();
      }
    }, 2600);
    return;
  }

  state.pendingSilentRefresh = false;
  renderPreservingComposer();
}

function sortMessagesByDate(messages) {
  return [...messages].sort((first, second) => {
    const firstTime = getMessageTimestamp(first);
    const secondTime = getMessageTimestamp(second);

    if (firstTime !== secondTime) {
      return firstTime - secondTime;
    }

    return String(first.id || "").localeCompare(String(second.id || ""));
  });
}

function getMessageTimestamp(message) {
  const value = message?.criado_em;
  if (!value) return 0;

  const normalized =
    typeof value === "string" && value.includes(" ") && !value.includes("T")
      ? value.replace(" ", "T")
      : value;

  const time = new Date(normalized).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function notifyIncomingMessage(conversation, count) {
  playIncomingMessageSound();

  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }

  const title = conversation.nomecliente || `Chat ${conversation.chat_id}`;
  const body =
    count > 1
      ? `${count} novas mensagens recebidas`
      : conversation.ultimo_conteudo || "Nova mensagem recebida";

  new Notification(title, {
    body,
    tag: getConversationKey(conversation),
  });
}

function playIncomingMessageSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(1174, audioContext.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.22);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.24);
  } catch {
    // Browsers can block audio until user interaction; polling continues normally.
  }
}

function subscribeToMessages(chatId) {
  if (state.realtimeChannel) {
    supabase.removeChannel(state.realtimeChannel);
  }

  state.realtimeChannel = supabase
    .channel(`mensagens:${state.selectedStoreId}:${chatId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "mensagens",
        filter: `chat_id=eq.${chatId}`,
      },
      async (payload) => {
        if (payload.new.loja_id !== state.selectedStoreId) return;
        if (state.messages.some((message) => message.id === payload.new.id)) return;

        state.messages = sortMessagesByDate([...state.messages, payload.new]);
        if (payload.new.remetente_tipo !== "atendente") {
          notifyIncomingMessage(state.activeConversation, 1);
        }
        await loadConversations({ notify: false });
        renderWhenIdle();
      }
    )
    .subscribe();
}

function scrollMessagesToBottom() {
  const list = document.querySelector("#message-list");
  if (list) list.scrollTop = list.scrollHeight;
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 3600);
}

loadInitialData();
