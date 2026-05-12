const app = document.querySelector("#app");
const config = window.CHAT_APP_CONFIG || {};
const SESSION_KEY = "crm_julia_chat_user";
const ZAIA_MESSAGE_API_URL =
  "https://core-service.zaia.app/v1.1/api/message-cross-channel/create";
const ZAIA_AGENT_ID = 70482;
const ZAIA_AUTH_TOKEN = "7ca346d9-0834-4559-b9ec-6eb8888320bd";
const FINISH_CHAT_WEBHOOK_URL =
  "https://hook.us1.make.com/lihc76dghcolia5uhycxenuovbv9vdux";
const DISPLAY_TIME_OFFSET_MS = -3 * 60 * 60 * 1000;

const state = {
  currentUser: null,
  stores: [],
  selectedStoreId: null,
  conversations: [],
  searchQuery: "",
  currentView: "chat",
  menuOpen: false,
  statusFilters: {
    active: true,
    finished: true,
  },
  adminStores: [],
  adminUsers: [],
  adminEditingUserId: "",
  adminLoading: false,
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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date.getTime() + DISPLAY_TIME_OFFSET_MS));
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
        <p class="eyebrow">Configuração pendente</p>
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
        <p>Acesse com seu usuário da plataforma Julia para visualizar somente as lojas liberadas para o seu atendimento.</p>
      </section>

      <section class="auth-panel" aria-label="Formulário de acesso">
        <div>
          <h2>Entrar</h2>
          <p>Preencha os dados para acessar.</p>
        </div>

        <form id="auth-form" class="stack">
          <label>
            E-mail
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
    <main class="workspace with-top-menu ${state.currentView !== "chat" ? "admin-mode" : ""}">
      ${renderTopMenu()}
      ${
        state.currentView === "password"
          ? renderPasswordPanel()
          : state.currentView === "admin" && canManageAccess()
          ? renderAdminPanel()
          : renderChatWorkspace()
      }
    </main>
  `;
}

function renderTopMenu() {
  return `
    <nav class="top-menu" aria-label="Menu principal">
      <div>
        <strong>Julia CRM</strong>
        <span>${escapeHtml(getRoleLabel(state.currentUser?.funcao))}</span>
      </div>
      <button class="menu-toggle" id="menu-toggle" type="button" aria-label="Abrir menu" aria-expanded="${state.menuOpen ? "true" : "false"}">
        <span></span>
        <span></span>
        <span></span>
      </button>
    </nav>
    ${renderSideMenu()}
  `;
}

function renderSideMenu() {
  return `
    <button class="menu-overlay ${state.menuOpen ? "open" : ""}" id="menu-overlay" type="button" aria-label="Fechar menu"></button>
    <aside class="side-menu ${state.menuOpen ? "open" : ""}" aria-label="Submenu principal">
      <header>
        <div>
          <p class="eyebrow">Menu</p>
          <strong>Julia CRM</strong>
          <span>${escapeHtml(getRoleLabel(state.currentUser?.funcao))}</span>
        </div>
        <button class="menu-close" id="menu-close" type="button" aria-label="Fechar menu">×</button>
      </header>
      <nav>
        <button class="${state.currentView === "chat" ? "active" : ""}" data-view="chat" type="button">Atendimento</button>
        ${canManageAccess() ? `<button class="${state.currentView === "admin" ? "active" : ""}" data-view="admin" type="button">Gestão de acessos</button>` : ""}
        <button class="${state.currentView === "password" ? "active" : ""}" data-view="password" type="button">Trocar senha</button>
      </nav>
      <button class="side-sign-out" id="side-sign-out" type="button">Sair</button>
    </aside>
  `;
}

function renderChatWorkspace() {
  return `
      <aside class="sidebar">
        <header class="sidebar-header">
          <div>
            <p class="eyebrow">Histórico</p>
            <h1>Conversas</h1>
          </div>
        </header>

        ${renderStoreSelector()}

        <form id="chat-search-form" class="new-chat">
          <input name="search" value="${escapeHtml(state.searchQuery)}" placeholder="Buscar nome ou WhatsApp" aria-label="Buscar nome ou WhatsApp" ${state.selectedStoreId ? "" : "disabled"} />
          <button type="submit" title="Filtrar busca" aria-label="Filtrar busca" ${state.selectedStoreId ? "" : "disabled"}>Buscar</button>
        </form>

        <fieldset class="status-filters">
          <legend>Status</legend>
          <label>
            <input type="checkbox" name="active" ${state.statusFilters.active ? "checked" : ""} />
            Em andamento
          </label>
          <label>
            <input type="checkbox" name="finished" ${state.statusFilters.finished ? "checked" : ""} />
            Finalizadas
          </label>
        </fieldset>

        <div class="conversation-list">
          ${renderConversationList()}
        </div>

        <button class="sign-out-button" id="sign-out" type="button">Sair</button>
      </aside>

      <section class="chat-panel">
        ${state.activeConversation ? renderChat() : renderEmptyChat()}
      </section>
  `;
}

function renderAdminPanel() {
  const editingUser = getEditingAdminUser();

  return `
    <section class="admin-panel">
      <header class="admin-header">
        <div>
          <p class="eyebrow">Gestão</p>
          <h1>Acessos por usuário e loja</h1>
          <p>Defina gestores por loja e quais lojas cada atendente pode visualizar.</p>
        </div>
        <button class="secondary-button" id="new-admin-user" type="button">Novo usuário</button>
      </header>

      ${
        state.adminLoading
          ? `<div class="admin-loading"><span class="loader"></span></div>`
          : `
            <div class="admin-grid">
              ${renderAdminUserForm(editingUser)}
              ${renderAdminUsersList()}
            </div>
          `
      }
    </section>
  `;
}

function renderPasswordPanel() {
  return `
    <section class="password-panel">
      <form id="password-form" class="admin-card password-card">
        <div>
          <p class="eyebrow">Segurança</p>
          <h1>Trocar senha</h1>
          <p>Atualize a senha usada para acessar a plataforma Julia CRM.</p>
        </div>

        <label>
          Senha atual
          <input type="password" name="current_password" autocomplete="current-password" required />
        </label>
        <label>
          Nova senha
          <input type="password" name="new_password" autocomplete="new-password" minlength="6" required />
        </label>
        <label>
          Confirmar nova senha
          <input type="password" name="confirm_password" autocomplete="new-password" minlength="6" required />
        </label>

        <button class="primary-button" type="submit">Atualizar senha</button>
      </form>
    </section>
  `;
}

function renderAdminUserForm(user) {
  const isEditing = Boolean(user?.id);
  const gestorStoreIds = new Set(user?.gestor_loja_ids || []);
  const atendenteStoreIds = new Set(user?.atendente_loja_ids || []);
  const selectedRole = user?.is_master ? "gestor" : user?.funcao || "atendente";
  const accessStoreIds =
    selectedRole === "gestor" ? gestorStoreIds : atendenteStoreIds;

  return `
    <form id="admin-user-form" class="admin-card admin-form">
      <input type="hidden" name="user_id" value="${escapeHtml(user?.id || "")}" />
      <div>
        <p class="eyebrow">${isEditing ? "Editar usuário" : "Novo usuário"}</p>
        <h2>${isEditing ? escapeHtml(user.name || user.email) : "Criar acesso"}</h2>
        ${user?.is_master ? `<p class="admin-note">Este usuário é master por e-mail predefinido.</p>` : ""}
      </div>

      <div class="admin-form-grid">
        <label>
          Nome
          <input name="name" value="${escapeHtml(user?.name || "")}" required />
        </label>
        <label>
          E-mail
          <input type="email" name="email" value="${escapeHtml(user?.email || "")}" required />
        </label>
        <label>
          Senha
          <input type="password" name="password" placeholder="${isEditing ? "Manter senha atual" : "Padrão: acesso123"}" />
        </label>
        <label>
          Função
          <select id="admin-role-selector" name="funcao">
            <option value="atendente" ${selectedRole === "atendente" ? "selected" : ""}>Atendente</option>
            <option value="gestor" ${selectedRole === "gestor" ? "selected" : ""}>Gestor</option>
          </select>
        </label>
      </div>

      <div id="admin-store-access">
        ${renderStoreCheckboxes(getAccessStoresTitle(selectedRole), "accessStores", accessStoreIds)}
      </div>

      <div class="admin-form-actions">
        <button class="primary-button" type="submit">${isEditing ? "Salvar usuário" : "Criar usuário"}</button>
      </div>
    </form>
  `;
}

function renderStoreCheckboxes(title, name, selectedIds) {
  if (!state.adminStores.length) {
    return `
      <fieldset class="store-checks">
        <legend>${title}</legend>
        <span>Nenhuma loja disponível.</span>
      </fieldset>
    `;
  }

  return `
    <fieldset class="store-checks">
      <legend>${title}</legend>
      <div class="store-checks-toolbar">
        <label>
          Buscar loja
          <input type="search" id="store-access-search" placeholder="Nome ou CNPJ" autocomplete="off" />
        </label>
        <label class="select-all-stores">
          <input type="checkbox" id="select-all-stores" />
          <span>Selecionar todos</span>
        </label>
      </div>
      <div>
        ${state.adminStores
          .map((store) => {
            const label = `${store.nome || "Loja sem nome"}${store.cnpj ? ` - ${store.cnpj}` : ""}`;
            return `
              <label data-store-access-label="${escapeHtml(label.toLowerCase())}">
                <input type="checkbox" name="${name}" value="${store.id}" ${selectedIds.has(store.id) ? "checked" : ""} />
                <span>${escapeHtml(label)}</span>
              </label>
            `;
          })
          .join("")}
      </div>
    </fieldset>
  `;
}

function getAccessStoresTitle(role) {
  return role === "gestor"
    ? "Lojas que o usuário pode gerenciar"
    : "Lojas que o atendente pode visualizar";
}

function renderAdminUsersList() {
  if (!state.adminUsers.length) {
    return `
      <div class="admin-card empty-list">
        <strong>Nenhum usuário encontrado</strong>
        <span>Crie o primeiro acesso para esta operação.</span>
      </div>
    `;
  }

  return `
    <div class="admin-card admin-users">
      <div>
        <p class="eyebrow">Usuários</p>
        <h2>${state.adminUsers.length} acessos</h2>
      </div>
      <div class="admin-user-list">
        ${state.adminUsers
          .map((user) => {
            const selected = state.adminEditingUserId === user.id;
            return `
              <button class="admin-user-item ${selected ? "active" : ""}" data-admin-user-id="${user.id}" type="button">
                <span>
                  <strong>${escapeHtml(user.name || "Sem nome")}</strong>
                  <small>${escapeHtml(user.email)}</small>
                </span>
                <span>${escapeHtml(getRoleLabel(user.funcao))}</span>
              </button>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderStoreSelector() {
  if (!state.stores.length) {
    return `
      <div class="store-strip">
        <strong>Nenhuma loja liberada</strong>
        <span>Inclua o usuário em <code>usuarios_atendentes</code> para liberar um CNPJ.</span>
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
        <span>Esta loja ainda não possui chats abertos.</span>
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
      const phone = conversation.telefone ? ` - ${conversation.telefone}` : "";
      const detail =
        conversation.ultimo_conteudo ||
        conversation.resumo ||
        conversation.telefone ||
        "Sem mensagens";

      return `
        <button class="conversation-item ${isActive ? "active" : ""}" data-conversation-id="${conversation.id}" type="button">
          <span class="conversation-copy">
            <span class="conversation-topline">
              <strong>${escapeHtml(title)}<span class="conversation-phone">${escapeHtml(phone)}</span></strong>
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

  return state.conversations.filter((conversation) => {
    if (!matchesStatusFilter(conversation)) {
      return false;
    }

    if (!query) {
      return true;
    }

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

function matchesStatusFilter(conversation) {
  const isActive = Boolean(conversation.status_ativo);
  if (isActive && state.statusFilters.active) return true;
  if (!isActive && state.statusFilters.finished) return true;
  return false;
}

function renderChat() {
  const title =
    state.activeConversation.nomecliente ||
    `Chat ${state.activeConversation.chat_id}`;
  const store = state.stores.find((item) => item.id === state.selectedStoreId);
  const status = state.activeConversation.status_ativo ? "ativo" : "encerrado";

  return `
    <header class="chat-header">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(`${store?.nome || "Loja"} - ${status}`)}</p>
      </div>
      <button class="finish-chat-button" id="finish-chat" type="button" ${state.activeConversation.status_ativo ? "" : "disabled"}>
        Finalizar
      </button>
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
        <p>Os chats aparecem conforme a loja escolhida. Cada CNPJ exibe apenas o histórico liberado para seu usuário.</p>
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
  document.querySelector("#side-sign-out")?.addEventListener("click", handleSignOut);
  document.querySelector("#menu-toggle")?.addEventListener("click", toggleSideMenu);
  document.querySelector("#menu-close")?.addEventListener("click", closeSideMenu);
  document.querySelector("#menu-overlay")?.addEventListener("click", closeSideMenu);
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => handleViewChange(button.dataset.view));
  });
  document.querySelector("#admin-user-form")?.addEventListener("submit", handleSaveAdminUser);
  document.querySelector("#password-form")?.addEventListener("submit", handleChangePassword);
  document.querySelector("#admin-role-selector")?.addEventListener("change", handleAdminRoleChange);
  document.querySelector("#store-access-search")?.addEventListener("input", handleStoreAccessSearch);
  document.querySelector("#select-all-stores")?.addEventListener("change", handleSelectAllStores);
  syncSelectAllStoresState();
  document.querySelector("#new-admin-user")?.addEventListener("click", handleNewAdminUser);
  document.querySelectorAll("[data-admin-user-id]").forEach((button) => {
    button.addEventListener("click", () => handleEditAdminUser(button.dataset.adminUserId));
  });
  document.querySelector("#store-selector")?.addEventListener("change", handleStoreChange);
  document.querySelector("#chat-search-form")?.addEventListener("submit", handleSearchChats);
  document.querySelector("#chat-search-form input")?.addEventListener("input", handleSearchInput);
  document.querySelectorAll(".status-filters input").forEach((input) => {
    input.addEventListener("change", handleStatusFilterChange);
  });
  document.querySelector("#message-form")?.addEventListener("submit", handleSendMessage);
  document.querySelector("#finish-chat")?.addEventListener("click", handleFinishChat);
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

async function handleViewChange(view) {
  if (view === state.currentView) {
    closeSideMenu();
    return;
  }
  if (view === "admin" && !canManageAccess()) return;

  state.menuOpen = false;
  state.currentView = ["admin", "password"].includes(view) ? view : "chat";

  if (state.currentView !== "chat") {
    stopMessagePolling();
    stopConversationListPolling();
    if (state.currentView === "admin") {
      await loadAdminData();
    }
  } else {
    if (state.selectedStoreId) {
      startConversationListPolling();
      if (state.activeConversation) startMessagePolling();
    }
  }

  render();
}

function toggleSideMenu() {
  state.menuOpen = !state.menuOpen;
  renderPreservingComposer();
}

function closeSideMenu() {
  if (!state.menuOpen) return;
  state.menuOpen = false;
  renderPreservingComposer();
}

async function handleChangePassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const currentPassword = String(formData.get("current_password") || "");
  const newPassword = String(formData.get("new_password") || "");
  const confirmPassword = String(formData.get("confirm_password") || "");

  if (newPassword !== confirmPassword) {
    showToast("A confirmação da senha não confere.");
    return;
  }

  const { error } = await supabase.rpc("alterar_senha_atendimento", {
    p_session_token: state.currentUser.session_token,
    p_senha_atual: currentPassword,
    p_nova_senha: newPassword,
  });

  if (error) {
    showToast(error.message);
    return;
  }

  form.reset();
  showToast("Senha atualizada.");
}

function handleNewAdminUser() {
  state.adminEditingUserId = "";
  render();
}

function handleEditAdminUser(userId) {
  state.adminEditingUserId = userId;
  render();
}

function handleAdminRoleChange(event) {
  const legend = document.querySelector("#admin-store-access legend");
  if (legend) {
    legend.textContent = getAccessStoresTitle(event.currentTarget.value);
  }
}

function handleStoreAccessSearch(event) {
  const query = event.currentTarget.value.trim().toLowerCase();
  document.querySelectorAll("[data-store-access-label]").forEach((item) => {
    const text = item.dataset.storeAccessLabel || "";
    item.hidden = Boolean(query) && !text.includes(query);
  });
  syncSelectAllStoresState();
}

function handleSelectAllStores(event) {
  getVisibleStoreAccessInputs().forEach((input) => {
    input.checked = event.currentTarget.checked;
  });
  syncSelectAllStoresState();
}

function getVisibleStoreAccessInputs() {
  return [...document.querySelectorAll('input[name="accessStores"]')].filter(
    (input) => !input.closest("[data-store-access-label]")?.hidden
  );
}

function syncSelectAllStoresState() {
  const selectAll = document.querySelector("#select-all-stores");
  if (!selectAll) return;

  const inputs = getVisibleStoreAccessInputs();
  const checkedCount = inputs.filter((input) => input.checked).length;
  selectAll.checked = inputs.length > 0 && checkedCount === inputs.length;
  selectAll.indeterminate = checkedCount > 0 && checkedCount < inputs.length;
}

async function handleSaveAdminUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const userId = String(formData.get("user_id") || "").trim();
  const selectedRole = String(formData.get("funcao") || "atendente");
  const accessStoreIds = getCheckedValues(form, "accessStores");

  const { data, error } = await supabase.rpc("admin_salvar_usuario", {
    p_session_token: state.currentUser.session_token,
    p_user_id: userId || null,
    p_name: String(formData.get("name") || "").trim(),
    p_email: String(formData.get("email") || "").trim(),
    p_password: String(formData.get("password") || ""),
    p_funcao: selectedRole,
    p_gestor_loja_ids: selectedRole === "gestor" ? accessStoreIds : [],
    p_atendente_loja_ids: selectedRole === "atendente" ? accessStoreIds : [],
  });

  if (error) {
    showToast(error.message);
    return;
  }

  state.adminEditingUserId = data?.[0]?.id || userId || "";
  await loadAdminData();
  await loadStores();
  showToast("Usuário salvo.");
  render();
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
    showToast("E-mail, senha ou permissão de loja inválida.");
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
  state.currentView = "chat";
  state.menuOpen = false;
  state.statusFilters = {
    active: true,
    finished: true,
  };
  state.adminStores = [];
  state.adminUsers = [];
  state.adminEditingUserId = "";
  state.adminLoading = false;
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

function handleStatusFilterChange(event) {
  state.statusFilters = {
    ...state.statusFilters,
    [event.currentTarget.name]: event.currentTarget.checked,
  };
  render();
}

function getCheckedValues(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(
    (input) => input.value
  );
}

function canManageAccess() {
  return ["master", "gestor"].includes(state.currentUser?.funcao);
}

function getRoleLabel(role) {
  if (role === "master") return "Master";
  if (role === "gestor") return "Gestor";
  return "Atendente";
}

function getEditingAdminUser() {
  if (!state.adminEditingUserId) return null;
  return (
    state.adminUsers.find((user) => user.id === state.adminEditingUserId) || null
  );
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

async function handleFinishChat() {
  if (!state.activeConversation || !state.selectedStoreId) return;

  const webhookError = await sendFinishChatWebhook(
    state.activeConversation.chat_id
  );
  if (webhookError) {
    showToast(webhookError);
    return;
  }

  const { data, error } = await supabase.rpc("finalizar_conversa_atendimento", {
    p_session_token: state.currentUser.session_token,
    p_loja_id: state.selectedStoreId,
    p_chat_id: state.activeConversation.chat_id,
  });

  if (error) {
    showToast(error.message);
    return;
  }

  const updated = data?.[0];
  if (updated) {
    state.activeConversation = {
      ...state.activeConversation,
      data_fim: updated.data_fim,
      status_ativo: updated.status_ativo,
    };
  }

  await loadConversations({ notify: false });
  syncActiveConversationFromList();
  render();
  showToast("Conversa finalizada.");
}

async function sendFinishChatWebhook(chatId) {
  try {
    const response = await fetch(FINISH_CHAT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: String(chatId),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return detail || `Erro ${response.status} ao chamar webhook de finalização.`;
    }

    return null;
  } catch (error) {
    return error.message || "Não foi possível chamar o webhook de finalização.";
  }
}

async function sendMessageToZaia(message) {
  const attendantMessage = String(message || "").trim();
  const phoneNumber = String(state.activeConversation.telefone || "").replace(
    /\D/g,
    ""
  );

  if (!phoneNumber) {
    return "O chat selecionado não possui telefone do cliente.";
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
    return error.message || "Não foi possível conectar na API da Zaia.";
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
    await refreshCurrentUserProfile();
    if (!state.currentUser) {
      state.loading = false;
      render();
      return;
    }
    requestNotificationPermission();
    await loadStores();
    if (!canManageAccess() && state.currentView === "admin") {
      state.currentView = "chat";
    }
    await loadConversations({ notify: false });
    if (state.conversations[0]) {
      await selectConversation(state.conversations[0].id, { silent: true });
    }
    if (state.currentView === "admin" && canManageAccess()) {
      await loadAdminData();
    } else {
      startConversationListPolling();
    }
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

async function refreshCurrentUserProfile() {
  if (!state.currentUser?.session_token) return;

  const { data, error } = await supabase.rpc("perfil_atendimento", {
    p_session_token: state.currentUser.session_token,
  });

  if (error || !data?.[0]) {
    localStorage.removeItem(SESSION_KEY);
    state.currentUser = null;
    return;
  }

  state.currentUser = {
    ...state.currentUser,
    ...data[0],
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(state.currentUser));
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

async function loadAdminData() {
  if (!canManageAccess()) return;

  state.adminLoading = true;
  render();

  const [storesResult, usersResult] = await Promise.all([
    supabase.rpc("admin_listar_lojas", {
      p_session_token: state.currentUser.session_token,
    }),
    supabase.rpc("admin_listar_usuarios", {
      p_session_token: state.currentUser.session_token,
    }),
  ]);

  if (storesResult.error) {
    showToast(storesResult.error.message);
  } else {
    state.adminStores = storesResult.data || [];
  }

  if (usersResult.error) {
    showToast(usersResult.error.message);
  } else {
    state.adminUsers = usersResult.data || [];
    if (
      state.adminEditingUserId &&
      !state.adminUsers.some((user) => user.id === state.adminEditingUserId)
    ) {
      state.adminEditingUserId = "";
    }
  }

  state.adminLoading = false;
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
    showToast("Conversa indisponível para a loja selecionada.");
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
