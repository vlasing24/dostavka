"use strict";
// ============================================================
// app.js — ядро веб-версии «База доставок» (Локальная версия)
// ============================================================

const STORAGE_KEY = "delivery_db_v1";

const state = {
    db: null,
    screen: "clients",
    currentDate: todayYmd(),
    searchQuery: "",
    limit: 50,
    clientSearch: "",
    priceSearch: "",
    selectedOrders: new Set(),
    isDirty: false, // Флаг: есть ли несохраненные изменения
};

function emptyDb() {
    return {
        meta: { version: 1, updated_at: "" },
        next_id: { client: 1, address: 1, order: 1, product: 1 },
        clients: [],
        orders: [],
        products: [],
        directory: [],
    };
}

function newId(kind) {
    state.db.next_id[kind] = Number.isFinite(state.db.next_id[kind]) ? state.db.next_id[kind] : 1;
    return state.db.next_id[kind]++;
}

// ---------------------------------------------------------------------------
// Хранение
// ---------------------------------------------------------------------------

let saveTimer = null;

function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            state.db.meta.updated_at = new Date().toISOString();
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state.db));
            state.isDirty = true; 
            updateBackupWarning(); 
        } catch (e) {
            console.error("persist:", e);
        }
    }, 400);
}

function loadFromStorage() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    try {
        state.db = migrateDb(JSON.parse(raw));
        return true;
    } catch (e) {
        console.error("loadFromStorage:", e);
        return false;
    }
}

function migrateDb(raw) {
    const db = Object.assign(emptyDb(), raw || {});
    db.next_id = Object.assign({ client: 1, address: 1, order: 1, product: 1 }, (raw && raw.next_id) || {});
    for (const key of ["clients", "orders", "products", "directory"]) {
        if (!Array.isArray(db[key])) db[key] = [];
    }

    const safeNum = (v) => Number.isFinite(v) ? v : 1;
    const maxIdOf = (arr) => arr.reduce(
        (m, x) => (x && Number.isFinite(x.id)) ? Math.max(m, x.id + 1) : m,
        1
    );

    db.next_id.client = Math.max(safeNum(db.next_id.client), maxIdOf(db.clients));
    db.next_id.order = Math.max(safeNum(db.next_id.order), maxIdOf(db.orders));
    db.next_id.product = Math.max(safeNum(db.next_id.product), maxIdOf(db.products));

    let maxAddr = 1;
    for (const c of db.clients) {
        if (!Array.isArray(c.addresses)) c.addresses = [];
        for (const a of c.addresses) {
            if (a && Number.isFinite(a.id)) maxAddr = Math.max(maxAddr, a.id + 1);
        }
    }
    db.next_id.address = Math.max(safeNum(db.next_id.address), maxAddr);
    return db;
}

function downloadJson(filename, data) {
    const blob = new Blob([data], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Модель: доступ к данным
// ---------------------------------------------------------------------------

function allAddresses() {
    const list = [];
    for (const c of state.db.clients) {
        for (const a of c.addresses) list.push({ client: c, address: a });
    }
    return list;
}

function findClient(id) { return state.db.clients.find((c) => c.id === id) || null; }
function findAddress(id) {
    for (const c of state.db.clients) {
        const addr = c.addresses.find((a) => a.id === id);
        if (addr) return { client: c, address: addr };
    }
    return null;
}
function findOrder(id) { return state.db.orders.find((o) => o.id === id) || null; }

function findClientByPhone(raw) {
    const key = canonicalPhone(raw).slice(-10);
    if (!key) return null;
    return state.db.clients.find((c) => {
        const own = canonicalPhone(c.phone).slice(-10);
        const ext = canonicalPhone(c.phone_extra || "").slice(-10);
        return own === key || (ext && ext === key);
    }) || null;
}

function orderAddress(order) {
    const found = findAddress(order.address_id);
    return found ? found.address : null;
}
function orderClient(order) { return findClient(order.client_id); }

function priceDict() {
    const dict = {};
    for (const p of state.db.products) {
        dict[p.name] = {
            price: p.price,
            unit: p.unit,
            synonyms: (p.synonyms || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
        };
    }
    return dict;
}

function itemsList(order) {
    const lines = (order.items || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const cleaned = [];
    for (let line of lines) {
        if (line.startsWith("---") || line.toUpperCase().startsWith("ИТОГО")) continue;
        if (line.startsWith("- ")) line = line.slice(2).trim();
        else if (line.startsWith("-")) line = line.slice(1).trim();
        if (line) cleaned.push(line);
    }
    return cleaned;
}

function formatMoney(n) { return (n || 0).toLocaleString("ru-RU"); }

function addressFull(a) {
    let s = `${a.street}, д. ${a.house}`;
    if (a.apartment) s += `, кв. ${a.apartment}`;
    if (a.entrance) s += `, под. ${a.entrance}`;
    return s;
}

function addrKey(a) {
    return [a.street, a.house, a.apartment, a.entrance]
        .map((x) => (x || "").toString().toLowerCase().trim())
        .join("|");
}

// ---------------------------------------------------------------------------
// Тосты и модалки
// ---------------------------------------------------------------------------

function toast(message, type = "") {
    const box = document.getElementById("toasts");
    const div = document.createElement("div");
    div.className = "toast-item " + type;
    div.textContent = message;
    box.appendChild(div);
    setTimeout(() => div.remove(), 5000);
}

let modalInstance = null;
function showModal(title, bodyHtml, footerHtml) {
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-body").innerHTML = bodyHtml;
    document.getElementById("modal-footer").innerHTML = footerHtml || "";
    if (!modalInstance) modalInstance = new bootstrap.Modal(document.getElementById("modal"));
    modalInstance.show();
}
function closeModal() { if (modalInstance) modalInstance.hide(); }
function confirmAction(message) { return window.confirm(message); }

// ---------------------------------------------------------------------------
// Роутер
// ---------------------------------------------------------------------------

const TAB_DEFS = [
    { id: "clients", label: "Клиенты", icon: "bi-people" },
    { id: "journal", label: "Журнал", icon: "bi-truck" },
    { id: "prices", label: "Прайс", icon: "bi-tags" },
    { id: "duplicates", label: "Дубли", icon: "bi-arrow-down-up" },
    { id: "data", label: "Данные", icon: "bi-database" },
];

function showScreen(name) {
    state.screen = name;
    renderTabs();
    if (name === "clients") renderClients();
    else if (name === "journal") renderJournal();
    else if (name === "prices") renderPrices();
    else if (name === "duplicates") renderDuplicates();
    else if (name === "data") renderData();
    window.scrollTo(0, 0);
}

function renderTabs() {
    const box = document.getElementById("top-tabs");
    box.innerHTML = TAB_DEFS.map((t) => `
        <button class="tab-btn ${state.screen === t.id ? "active" : ""}" data-tab="${t.id}">
            <i class="bi ${t.icon}"></i> ${t.label}
        </button>`).join("");
    for (const btn of box.querySelectorAll(".tab-btn")) {
        btn.addEventListener("click", () => showScreen(btn.dataset.tab));
    }
}

// ---------------------------------------------------------------------------
// Экран: Клиенты
// ---------------------------------------------------------------------------

function clientMatches(c, a, q) {
    return (
        (c.name || "").toLowerCase().includes(q) || c.phone.includes(q) ||
        (c.phone_extra || "").includes(q) || (a.street || "").toLowerCase().includes(q) ||
        (a.house || "").includes(q) || (a.apartment || "").includes(q)
    );
}

function filteredAddresses() {
    const q = state.clientSearch.trim().toLowerCase();
    let list = allAddresses();
    if (q) {
        const words = q.split(/\s+/);
        list = list.filter((item) => words.every((w) => clientMatches(item.client, item.address, w)));
    }
    list.sort((x, y) => {
        const s1 = `${x.address.street} ${x.address.house}`;
        const s2 = `${y.address.street} ${y.address.house}`;
        return s1.localeCompare(s2, "ru");
    });
    return list;
}

function renderClients() {
    const all = filteredAddresses();
    const total = all.length;
    const shown = all.slice(0, state.limit);
    const isLimited = total > shown.length;

    const rows = shown.map(({ client: c, address: a }) => `
        <tr>
            <td>
                <div class="address-main">${escapeHtml(c.name || "Без имени")}</div>
                <a href="tel:${c.phone}" class="phone-link"><i class="bi bi-telephone"></i>${escapeHtml(c.phone)}</a>
                ${c.phone_extra ? `<div class="phone-extra">${escapeHtml(c.phone_extra)}${c.phone_extra_name ? " (" + escapeHtml(c.phone_extra_name) + ")" : ""}</div>` : ""}
            </td>
            <td>
                <div class="address-main">${escapeHtml(a.street)}, д. ${escapeHtml(a.house)}</div>
                <div class="address-detail">
                    ${a.apartment ? `<span>кв. ${escapeHtml(a.apartment)}</span>` : ""}
                    ${a.entrance ? `<span>под. ${escapeHtml(a.entrance)}</span>` : ""}
                </div>
            </td>
            <td class="text-nowrap">
                <button class="btn-action edit" data-act="edit-client" data-id="${c.id}" title="Редактировать"><i class="bi bi-pencil"></i></button>
                <button class="btn-action ok" data-act="new-order" data-id="${a.id}" title="Добавить доставку"><i class="bi bi-plus-lg"></i></button>
                <button class="btn-action fail" data-act="delete-address" data-id="${a.id}" title="Удалить запись"><i class="bi bi-trash"></i></button>
            </td>
        </tr>`).join("");

    document.getElementById("screen").innerHTML = `
        <div class="custom-card">
            <div class="custom-card-header">
                <span><i class="bi bi-person-plus icon-primary me-2"></i>Добавить нового клиента</span>
            </div>
            <div class="card-body p-3">
                <div class="row g-2">
                    <div class="col-6 col-md-3"><input type="text" id="c-phone" class="form-control" placeholder="Телефон *"></div>
                    <div class="col-6 col-md-3"><input type="text" id="c-name" class="form-control" placeholder="Имя / Пометка"></div>
                    <div class="col-6 col-md-3"><input type="text" id="c-phone-extra" class="form-control" placeholder="Доп. телефон"></div>
                    <div class="col-6 col-md-3"><input type="text" id="c-phone-extra-name" class="form-control" placeholder="Кому принадлежит"></div>
                    <div class="col-12"><input type="text" id="c-street" class="form-control" placeholder="Улица / Микрорайон *"></div>
                    <div class="col-4 col-md-2"><input type="text" id="c-house" class="form-control" placeholder="Дом *"></div>
                    <div class="col-4 col-md-2"><input type="text" id="c-apartment" class="form-control" placeholder="Кв/Офис"></div>
                    <div class="col-4 col-md-2"><input type="text" id="c-entrance" class="form-control" placeholder="Подъезд"></div>
                    <div class="col-12 col-md-6 d-flex align-items-end">
                        <button class="btn btn-primary w-100" id="add-client-btn"><i class="bi bi-check2-circle me-1"></i> Сохранить</button>
                    </div>
                </div>
            </div>
        </div>

        <div class="custom-card">
            <div class="custom-card-header">
                <div class="d-flex align-items-center gap-3">
                    <span><i class="bi bi-people me-2"></i>Клиенты</span>
                    <span class="count-badge">${total}</span>
                </div>
                <div class="header-actions">
                    <select id="limit-select" class="form-select limit-select">
                        ${[20, 50, 100, 200].map((n) => `<option value="${n}" ${state.limit === n ? "selected" : ""}>${n}</option>`).join("")}
                        <option value="99999" ${state.limit > 200 ? "selected" : ""}>Все</option>
                    </select>
                    <div class="search-wrapper">
                        <i class="bi bi-search"></i>
                        <input type="text" id="client-search" class="form-control search-input" placeholder="Поиск (имя, телефон, улица)..." value="${escapeHtml(state.clientSearch)}">
                        <i class="bi bi-x-circle-fill clear-icon" id="clear-client-search" style="${state.clientSearch ? "" : "display:none"}"></i>
                    </div>
                    <div class="d-flex gap-2">
                        <button class="btn-nav" id="export-csv-btn"><i class="bi bi-file-earmark-excel"></i> Экспорт</button>
                        <button class="btn-nav" id="import-csv-btn"><i class="bi bi-file-earmark-arrow-up"></i> Импорт CSV</button>
                    </div>
                </div>
            </div>
            <div class="table-responsive">
                <table class="table">
                    <thead><tr>
                        <th style="width:38%">Клиент</th>
                        <th>Адрес</th>
                        <th style="width:130px"></th>
                    </tr></thead>
                    <tbody>${rows || `<tr><td colspan="3"><div class="empty-state">Клиентов нет — добавьте первого выше.</div></td></tr>`}</tbody>
                </table>
            </div>
            ${isLimited ? `<div class="small-note p-3">Показано ${shown.length} из ${total}. Увеличьте лимит, чтобы увидеть остальные.</div>` : ""}
        </div>`;

    bindClientsScreen();
}

function bindClientsScreen() {
    document.getElementById("add-client-btn").addEventListener("click", () => {
        const phone = canonicalPhone(document.getElementById("c-phone").value);
        const street = document.getElementById("c-street").value.trim();
        const house = document.getElementById("c-house").value.trim();
        if (!phone) return toast("Укажите телефон", "err");
        if (!street || !house) return toast("Укажите улицу и дом", "err");
        if (findClientByPhone(phone)) return toast(`Клиент с телефоном ${phone} уже есть в базе`, "err");

        const client = {
            id: newId("client"),
            name: document.getElementById("c-name").value.trim(),
            phone,
            phone_extra: canonicalPhone(document.getElementById("c-phone-extra").value),
            phone_extra_name: document.getElementById("c-phone-extra-name").value.trim(),
            notes: "",
            addresses: [{
                id: newId("address"), street, house,
                apartment: document.getElementById("c-apartment").value.trim(),
                entrance: document.getElementById("c-entrance").value.trim(),
                floor: "", intercom: "", notes: "",
            }],
        };
        state.db.clients.push(client);
        persist();
        toast("Запись успешно добавлена!", "ok");
        renderClients();
    });

    const search = document.getElementById("client-search");
    let timer = null;
    search.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.clientSearch = search.value; renderClients(); }, 250);
    });
    document.getElementById("clear-client-search").addEventListener("click", () => { state.clientSearch = ""; renderClients(); });
    document.getElementById("limit-select").addEventListener("change", (e) => { state.limit = parseInt(e.target.value, 10) || 50; renderClients(); });
    document.getElementById("export-csv-btn").addEventListener("click", exportCsv);
    document.getElementById("import-csv-btn").addEventListener("click", importCsvDialog);

    for (const btn of document.querySelectorAll('[data-act="edit-client"]')) {
        btn.addEventListener("click", () => openClientModal(parseInt(btn.dataset.id, 10)));
    }
    for (const btn of document.querySelectorAll('[data-act="new-order"]')) {
        btn.addEventListener("click", () => openOrderModal(null, parseInt(btn.dataset.id, 10)));
    }
    for (const btn of document.querySelectorAll('[data-act="delete-address"]')) {
        btn.addEventListener("click", () => {
            const found = findAddress(parseInt(btn.dataset.id, 10));
            if (!found) return;
            if (!confirmAction(`Удалить запись «${found.client.name || found.client.phone}» — адрес ${addressFull(found.address)}?`)) return;
            
            found.client.addresses = found.client.addresses.filter((a) => a.id !== found.address.id);
            if (!found.client.addresses.length) {
                state.db.clients = state.db.clients.filter((c) => c.id !== found.client.id);
                toast("Запись удалена (у клиента не осталось адресов).", "ok");
            } else {
                toast("Адрес удалён.", "ok");
            }
            persist();
            renderClients();
        });
    }
}

// ---------------------------------------------------------------------------
// Модалка клиента
// ---------------------------------------------------------------------------

function clientAddressRow(a) {
    const listId = `houses-list-${a.id}`;
    return `
        <div class="addr-row row g-2 mb-2 align-items-end" data-id="${a.id}">
            <div class="col-6">
                <label class="field-label">Улица *</label>
                <input type="text" class="form-control form-control-sm street-input" list="streets-datalist" value="${escapeHtml(a.street)}">
            </div>
            <div class="col-3">
                <input type="text" class="form-control form-control-sm house-input" list="${listId}" placeholder="Дом *" value="${escapeHtml(a.house)}">
                <datalist id="${listId}"></datalist>
            </div>
            <div class="col-3"><input type="text" class="form-control form-control-sm apartment-input" placeholder="Кв/Офис" value="${escapeHtml(a.apartment)}"></div>
            <div class="col-4 col-md-2"><input type="text" class="form-control form-control-sm entrance-input" placeholder="Подъезд" value="${escapeHtml(a.entrance)}"></div>
            <div class="col-8 col-md-10"><input type="text" class="form-control form-control-sm" placeholder="Примечания (этаж, домофон и т.п.)" value="${escapeHtml(a.notes || "")}" data-addr-notes="${a.id}"></div>
            <div class="col-12 col-md-2">
                <button type="button" class="btn-action fail delete-addr" data-addr-id="${a.id}" title="Удалить адрес"><i class="bi bi-trash"></i></button>
            </div>
        </div>`;
}

function orderHistoryRow(o) {
    const statusClass = o.status === "delivered" ? "bg-success bg-opacity-25" : o.status === "failed" ? "bg-danger bg-opacity-25" : "bg-warning";
    const statusText = o.status === "delivered" ? "Доставлено" : o.status === "failed" ? "Не застали" : "Ожидает";
    let payPill = "";
    if (o.payment_status) {
        const cls = o.payment_status === "Оплачено" ? "pay-ok" : o.payment_status === "Не оплачено" ? "pay-no" : o.payment_status === "Выигрыш" ? "pay-gift" : "pay-other";
        payPill = `<span class="pay-pill ${cls}">${escapeHtml(o.payment_status)}</span>`;
    }
    const addr = orderAddress(o);
    return `
        <div class="history-item">
            <div class="history-date">${fmtDate(o.date)}</div>
            <div class="history-body">
                <div class="history-line">
                    <span class="badge ${statusClass}">${statusText}</span>
                    ${payPill}
                    ${o.amount ? `<span class="history-amount">${formatMoney(o.amount)} руб.</span>` : ""}
                    ${addr ? `<span class="history-addr"><i class="bi bi-geo-alt"></i>${escapeHtml(addressFull(addr))}</span>` : ""}
                    <button class="btn-action edit history-repeat" data-act="repeat-order" data-id="${o.address_id}" title="Заказать снова"><i class="bi bi-arrow-repeat"></i></button>
                </div>
                <div class="history-items">${escapeHtml(itemsList(o).join(", "))}</div>
                ${o.comment ? `<div class="history-meta"><i class="bi bi-chat-left-text"></i>${escapeHtml(o.comment)}</div>` : ""}
            </div>
        </div>`;
}

function openClientModal(clientId) {
    const client = findClient(clientId);
    if (!client) return;

    const history = state.db.orders.filter((o) => o.client_id === clientId).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    const delivered = history.filter((o) => o.status === "delivered");
    const totalSpent = delivered.reduce((sum, o) => sum + (o.amount || 0), 0);
    const lastDate = history.length ? history[0].date : null;

    const allStreets = allAddresses().map(item => item.address.street).filter(Boolean);
    const streets = [...new Set(allStreets)].sort((a, b) => a.localeCompare(b, "ru"));
    const streetOptions = streets.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("");

    showModal(`Клиент: ${client.name || client.phone}`, `
        <datalist id="streets-datalist">${streetOptions}</datalist>
        <div class="section-title mt-2"><i class="bi bi-telephone"></i> Контакты</div>
        <div class="row g-2 mb-3">
            <div class="col-6"><input type="text" id="m-phone" class="form-control form-control-sm" placeholder="Телефон *" value="${escapeHtml(client.phone)}"></div>
            <div class="col-6"><input type="text" id="m-name" class="form-control form-control-sm" placeholder="Имя / Пометка" value="${escapeHtml(client.name || "")}"></div>
            <div class="col-6"><input type="text" id="m-phone-extra" class="form-control form-control-sm" placeholder="Доп. телефон" value="${escapeHtml(client.phone_extra || "")}"></div>
            <div class="col-6"><input type="text" id="m-phone-extra-name" class="form-control form-control-sm" placeholder="Кому принадлежит доп." value="${escapeHtml(client.phone_extra_name || "")}"></div>
            <div class="col-12"><textarea id="m-notes" class="form-control form-control-sm" rows="2" placeholder="Заметки о клиенте">${escapeHtml(client.notes || "")}</textarea></div>
        </div>
        <div class="section-title"><i class="bi bi-geo-alt"></i> Адреса доставки</div>
        <div id="m-addresses"></div>
        <button type="button" class="btn-nav mt-2" id="m-add-address"><i class="bi bi-plus-lg"></i> Добавить адрес</button>
        <hr>
        <div class="section-title"><i class="bi bi-clock-history"></i> История заказов</div>
        <div class="order-history-stats mb-2" style="border:1px solid var(--border-soft); border-radius:12px">
            <div><i class="bi bi-check2-circle"></i>Доставлено: <b>${delivered.length}</b></div>
            <div><i class="bi bi-cash-coin"></i>Сумма: <b>${formatMoney(totalSpent)} руб.</b></div>
            ${lastDate ? `<div><i class="bi bi-calendar3"></i>Последний: <b>${fmtDate(lastDate)}</b></div>` : ""}
        </div>
        <div>${history.length ? history.map(orderHistoryRow).join("") : '<div class="history-empty">Нет заказов.</div>'}</div>
    `, `
        <button class="btn btn-cancel" data-bs-dismiss="modal">Закрыть</button>
        <button class="btn btn-primary" id="m-save-client"><i class="bi bi-check2-circle me-1"></i> Сохранить</button>
    `);

    let editAddresses = client.addresses.map((a) => Object.assign({}, a));

    const collectAddressesFromDom = () => {
        const result = [];
        for (const row of document.querySelectorAll("#m-addresses .addr-row")) {
            const id = parseInt(row.dataset.id, 10);
            result.push({
                id, street: row.querySelector(".street-input").value.trim(),
                house: row.querySelector(".house-input").value.trim(),
                apartment: row.querySelector(".apartment-input").value.trim(),
                entrance: row.querySelector(".entrance-input").value.trim(),
                notes: row.querySelector("[data-addr-notes]").value.trim()
            });
        }
        return result;
    };

    const bindHouseHints = (root) => {
        const streetInput = root.querySelector(".street-input");
        const list = root.querySelector("datalist");
        if (!streetInput || !list) return;
        const fill = () => {
            const streetVal = streetInput.value.trim().toLowerCase();
            if (!streetVal) { list.innerHTML = ""; return; }
            const houses = allAddresses().filter(item => (item.address.street || "").toLowerCase() === streetVal).map(item => item.address.house);
            list.innerHTML = [...new Set(houses)].map((h) => `<option value="${escapeHtml(h)}">`).join("");
        };
        streetInput.addEventListener("input", fill);
        if (streetInput.value.trim().length > 0) fill();
    };

    const renderAddresses = () => {
        const container = document.getElementById("m-addresses");
        container.innerHTML = editAddresses.map((a) => clientAddressRow(a)).join("");
        for (const row of container.querySelectorAll(".addr-row")) {
            bindHouseHints(row);
            row.querySelector(".delete-addr").addEventListener("click", () => {
                editAddresses = collectAddressesFromDom().filter((a) => a.id !== parseInt(row.dataset.id, 10));
                renderAddresses();
            });
        }
    };
    renderAddresses();

    document.getElementById("m-add-address").addEventListener("click", () => {
        editAddresses = collectAddressesFromDom();
        editAddresses.push({ id: newId("address"), street: "", house: "", apartment: "", entrance: "", notes: "" });
        renderAddresses();
    });

    for (const btn of document.querySelectorAll('[data-act="repeat-order"]')) {
        btn.addEventListener("click", () => openOrderModal(null, parseInt(btn.dataset.id, 10)));
    }

    document.getElementById("m-save-client").addEventListener("click", () => {
        const phone = canonicalPhone(document.getElementById("m-phone").value);
        if (!phone) return toast("Телефон обязателен", "err");
        const another = findClientByPhone(phone);
        if (another && another.id !== client.id) return toast(`Телефон уже есть у другого клиента`, "err");

        const nextAddresses = collectAddressesFromDom();
        if (!nextAddresses.length || nextAddresses.some(a => !a.street || !a.house)) return toast("Заполните улицу и дом во всех адресах", "err");

        client.phone = phone;
        client.name = document.getElementById("m-name").value.trim();
        client.phone_extra = canonicalPhone(document.getElementById("m-phone-extra").value);
        client.phone_extra_name = document.getElementById("m-phone-extra-name").value.trim();
        client.notes = document.getElementById("m-notes").value;
        client.addresses = nextAddresses;

        for (const a of client.addresses) {
            if (!state.db.directory.some((d) => d.street === a.street && d.house === a.house)) {
                state.db.directory.push({ street: a.street, house: a.house });
            }
        }

        persist();
        toast("Изменения сохранены.", "ok");
        closeModal();
        renderClients();
    });
}

// ---------------------------------------------------------------------------
// Журнал доставок
// ---------------------------------------------------------------------------

const STATUS_META = {
    new: { label: "Ожидает", badge: "bg-warning" },
    delivered: { label: "Доставлено", badge: "bg-success bg-opacity-25" },
    failed: { label: "Не застали", badge: "bg-danger bg-opacity-25" },
};

function journalOrders(date) {
    return state.db.orders.filter((o) => o.date === date).sort((a, b) => {
        const rank = { new: 0, delivered: 1, failed: 1 };
        return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.id - b.id;
    });
}

function renderJournal() {
    const orders = journalOrders(state.currentDate);
    const active = orders.filter((o) => o.status === "new");
    const delivered = orders.filter((o) => o.status === "delivered");
    const totalAmount = orders.filter((o) => o.status !== "failed").reduce((s, o) => s + (o.amount || 0), 0);
    const unpaid = orders.filter((o) => o.payment_status === "Не оплачено");
    const unpaidAmount = unpaid.reduce((s, o) => s + (o.amount || 0), 0);
    const allSelected = orders.length > 0 && state.selectedOrders.size === orders.length;

    const rows = orders.map((o) => {
        const client = orderClient(o);
        const addr = orderAddress(o);
        const meta = STATUS_META[o.status] || STATUS_META.new;
        let payPill = "";
        if (o.payment_status) {
            const cls = o.payment_status === "Оплачено" ? "pay-ok" : o.payment_status === "Не оплачено" ? "pay-no" : o.payment_status === "Выигрыш" ? "pay-gift" : "pay-other";
            payPill = `<span class="pay-pill ${cls}">${escapeHtml(o.payment_status)}</span>`;
        }
        return `
        <tr>
            <td><input type="checkbox" class="order-check" data-id="${o.id}" ${state.selectedOrders.has(o.id) ? "checked" : ""}></td>
            <td>
                <div class="address-main">${escapeHtml(client ? (client.name || "Без имени") : "?")}</div>
                ${client ? `<a href="tel:${client.phone}" class="phone-link"><i class="bi bi-telephone"></i>${escapeHtml(client.phone)}</a>` : ""}
            </td>
            <td>${addr ? `<div class="address-main">${escapeHtml(addressFull(addr))}</div>${addr.notes ? `<div class="address-detail">${escapeHtml(addr.notes)}</div>` : ""}` : "—"}</td>
            <td style="min-width:180px"><div class="history-items">${escapeHtml(itemsList(o).join("; "))}</div>${o.comment ? `<div class="history-meta"><i class="bi bi-chat-left-text"></i>${escapeHtml(o.comment)}</div>` : ""}</td>
            <td class="text-nowrap">${o.amount ? `<b>${formatMoney(o.amount)} ₽</b>` : ""} ${payPill}</td>
            <td><span class="badge ${meta.badge}">${meta.label}</span></td>
            <td class="text-nowrap">
                <button class="btn-action ok" data-act="order-delivered" data-id="${o.id}" title="Доставлено"><i class="bi bi-check2"></i></button>
                <button class="btn-action fail" data-act="order-failed" data-id="${o.id}" title="Не застали"><i class="bi bi-x"></i></button>
                <button class="btn-action info" data-act="order-reset" data-id="${o.id}" title="Сбросить"><i class="bi bi-arrow-counterclockwise"></i></button>
                <button class="btn-action edit" data-act="order-edit" data-id="${o.id}" title="Редактировать"><i class="bi bi-pencil"></i></button>
                <button class="btn-action fail" data-act="order-delete" data-id="${o.id}" title="Удалить"><i class="bi bi-trash"></i></button>
            </td>
        </tr>`;
    }).join("");

    const routeUrl = active.length ? "https://yandex.ru/maps/?rtext=" + encodeURIComponent(active.map((o) => {
        const addr = orderAddress(o); return addr ? `Лесосибирск, ${addr.street}, ${addr.house}` : "";
    }).filter(Boolean).join("~")) + "&rtt=auto" : "";

    document.getElementById("screen").innerHTML = `
        <div class="custom-card">
            <div class="custom-card-header">
                <div class="d-flex align-items-center gap-2">
                    <button class="btn-nav" id="prev-day"><i class="bi bi-chevron-left"></i></button>
                    <span style="min-width:190px; text-align:center" class="fw-bold">${fmtDate(state.currentDate)} <span class="text-muted small">(${weekdayRu(state.currentDate)})</span></span>
                    <button class="btn-nav" id="next-day"><i class="bi bi-chevron-right"></i></button>
                    <input type="date" id="journal-date" class="form-control form-control-sm" style="max-width:150px" value="${state.currentDate}">
                    <button class="btn-nav" id="go-today"><i class="bi bi-calendar-check"></i> Сегодня</button>
                </div>
                <div class="d-flex align-items-center gap-2 flex-wrap">
                    <button class="btn-nav" id="journal-add"><i class="bi bi-plus-lg"></i> Добавить</button>
                    <a class="btn-nav ${routeUrl ? "" : "disabled"}" ${routeUrl ? `href="${routeUrl}" target="_blank" rel="noopener"` : ""}><i class="bi bi-signpost-split"></i> Маршрут</a>
                    <button class="btn-nav" id="journal-route-text"><i class="bi bi-clipboard"></i> Текст для курьера</button>
                    <button class="btn-nav" id="journal-import"><i class="bi bi-file-earmark-arrow-up"></i> Импорт</button>
                </div>
            </div>
            <div class="order-history-stats">
                <div><i class="bi bi-box"></i>Всего: <b>${orders.length}</b></div>
                <div><i class="bi bi-hourglass"></i>Ожидают: <b>${active.length}</b></div>
                <div><i class="bi bi-check2-circle"></i>Доставлено: <b>${delivered.length}</b></div>
                <div><i class="bi bi-cash-coin"></i>Сумма: <b>${formatMoney(totalAmount)} ₽</b></div>
                ${unpaid.length ? `<div><i class="bi bi-exclamation-circle" style="color:var(--danger)"></i>Не оплачено: <b>${unpaid.length}</b> на <b>${formatMoney(unpaidAmount)} ₽</b></div>` : ""}
            </div>
            <div class="table-responsive">
                <table class="table">
                    <thead><tr>
                        <th><input type="checkbox" id="check-all" ${allSelected ? "checked" : ""}></th>
                        <th>Клиент</th><th>Адрес</th><th>Что везём</th><th>Сумма</th><th>Статус</th><th></th>
                    </tr></thead>
                    <tbody>${rows || `<tr><td colspan="7"><div class="empty-state">На этот день доставок нет.<br>Добавьте вручную или импортируйте список.</div></td></tr>`}</tbody>
                </table>
            </div>
            ${state.selectedOrders.size ? `
            <div class="card-footer-bar">
                <span class="small-note me-auto">Выбрано: ${state.selectedOrders.size}</span>
                <button class="btn-nav" id="bulk-delivered"><i class="bi bi-check2-all"></i> Доставлено</button>
                <button class="btn-nav" id="bulk-failed"><i class="bi bi-x-circle"></i> Не застали</button>
                <button class="btn-nav" id="bulk-delete"><i class="bi bi-trash"></i> Удалить</button>
            </div>` : ""}
        </div>`;

    bindJournalScreen();
}

function bindJournalScreen() {
    document.getElementById("prev-day").addEventListener("click", () => { state.currentDate = shiftDate(state.currentDate, -1); state.selectedOrders.clear(); renderJournal(); });
    document.getElementById("next-day").addEventListener("click", () => { state.currentDate = shiftDate(state.currentDate, 1); state.selectedOrders.clear(); renderJournal(); });
    document.getElementById("journal-date").addEventListener("change", (e) => { state.currentDate = e.target.value || todayYmd(); state.selectedOrders.clear(); renderJournal(); });
    document.getElementById("go-today").addEventListener("click", () => { state.currentDate = todayYmd(); renderJournal(); });
    document.getElementById("journal-add").addEventListener("click", () => openOrderModal());
    document.getElementById("journal-import").addEventListener("click", (e) => { e.preventDefault(); openImportModal(); });
    document.getElementById("journal-route-text").addEventListener("click", openRouteTextModal);

    for (const btn of document.querySelectorAll('[data-act^="order-"]')) {
        btn.addEventListener("click", () => {
            const id = parseInt(btn.dataset.id, 10);
            const act = btn.dataset.act;
            const order = findOrder(id);
            if (!order) return;
            if (act === "order-delivered") { order.status = "delivered"; persist(); renderJournal(); }
            else if (act === "order-failed") { order.status = "failed"; persist(); renderJournal(); }
            else if (act === "order-reset") { order.status = "new"; persist(); renderJournal(); }
            else if (act === "order-edit") openOrderModal(order);
            else if (act === "order-delete") {
                if (!confirmAction("Удалить заказ из журнала?")) return;
                state.db.orders = state.db.orders.filter((o) => o.id !== id);
                state.selectedOrders.delete(id);
                persist(); toast("Заказ удалён.", "ok"); renderJournal();
            }
        });
    }

    const checkAll = document.getElementById("check-all");
    if (checkAll) checkAll.addEventListener("change", (e) => {
        state.selectedOrders.clear();
        if (e.target.checked) for (const o of journalOrders(state.currentDate)) state.selectedOrders.add(o.id);
        renderJournal();
    });
    for (const cb of document.querySelectorAll(".order-check")) {
        cb.addEventListener("change", () => {
            const id = parseInt(cb.dataset.id, 10);
            if (cb.checked) state.selectedOrders.add(id); else state.selectedOrders.delete(id);
            renderJournal();
        });
    }
    
    const bulk = (btnId, handler) => { const btn = document.getElementById(btnId); if (btn) btn.addEventListener("click", handler); };
    bulk("bulk-delivered", () => {
        for (const id of state.selectedOrders) { const o = findOrder(id); if (o) o.status = "delivered"; }
        toast(`Статус «Доставлено» у ${state.selectedOrders.size} заказов.`, "ok");
        state.selectedOrders.clear(); persist(); renderJournal();
    });
    bulk("bulk-failed", () => {
        for (const id of state.selectedOrders) { const o = findOrder(id); if (o) o.status = "failed"; }
        toast(`Статус «Не застали» у ${state.selectedOrders.size} заказов.`, "ok");
        state.selectedOrders.clear(); persist(); renderJournal();
    });
    bulk("bulk-delete", () => {
        if (!confirmAction(`Удалить выбранные заказы (${state.selectedOrders.size})?`)) return;
        state.db.orders = state.db.orders.filter((o) => !state.selectedOrders.has(o.id));
        toast(`Удалено заказов: ${state.selectedOrders.size}.`, "ok");
        state.selectedOrders.clear(); persist(); renderJournal();
    });
}

// ---------------------------------------------------------------------------
// Текст для курьера
// ---------------------------------------------------------------------------

function buildRouteText() {
    const active = journalOrders(state.currentDate).filter((o) => o.status === "new");
    let text = "";
    for (const order of active) {
        const client = orderClient(order);
        const addr = orderAddress(order);
        if (!addr || !client) continue;
        text += `📍 ${addr.street}, ${addr.house}${addr.apartment ? ", кв. " + addr.apartment : ""}${addr.entrance ? " (под. " + addr.entrance + ")" : ""}\n`;
        text += `📞 ${client.phone}\n📦 Товары:\n`;
        for (const item of itemsList(order)) text += `  - ${item}\n`;
        if (order.payment_status) {
            if (order.payment_status === "Выигрыш") text += "🎁 ВЫИГРЫШ (БЕСПЛАТНО)\n";
            else if (order.payment_status === "Не оплачено") text += "💸 НЕ ОПЛАЧЕНО\n";
            else if (order.payment_status === "Оплачено") text += "✅ ОПЛАЧЕНО\n";
        }
        if (order.amount > 0 && order.payment_status !== "Оплачено" && order.payment_status !== "Выигрыш") text += `💵 СУММА: ${order.amount} руб.\n`;
        if (order.comment) text += `💬 ${order.comment}\n`;
        text += "--------------------\n";
    }
    return text;
}

function openRouteTextModal() {
    const text = buildRouteText();
    const isEmpty = !text.trim();
    showModal("Текст для курьера", `
        ${isEmpty ? `<div class="alert alert-warning py-2 small mb-2">На эту дату нет активных заказов.</div>` : ""}
        <textarea id="route-text-area" class="form-control" rows="${isEmpty ? 4 : 16}" style="font-size:13px" ${isEmpty ? "disabled" : ""}>${escapeHtml(text)}</textarea>
    `, `
        <button class="btn btn-cancel" data-bs-dismiss="modal">Закрыть</button>
        <button class="btn btn-primary" id="copy-route-btn" ${isEmpty ? "disabled" : ""}><i class="bi bi-clipboard-check me-1"></i> Скопировать</button>
    `);
    document.getElementById("copy-route-btn").addEventListener("click", async (e) => {
        const area = document.getElementById("route-text-area");
        try {
            await navigator.clipboard.writeText(area.value);
            const btn = e.currentTarget;
            btn.innerHTML = '<i class="bi bi-check2-all me-1"></i> Скопировано!';
            setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard-check me-1"></i> Скопировать'; }, 2000);
        } catch (err) { area.select(); document.execCommand("copy"); toast("Скопировано.", "ok"); }
    });
}

// ---------------------------------------------------------------------------
// Модалка заказа
// ---------------------------------------------------------------------------

function openOrderModal(order, addressId) {
    if (order) addressId = order.address_id;
    let client = null;
    if (addressId) {
        const found = findAddress(addressId);
        if (found) { client = found.client; addressId = found.address.id; }
    }

    const isEdit = !!order;
    showModal(isEdit ? "Редактирование доставки" : "Новая доставка", `
        <div class="section-title mt-2"><i class="bi bi-telephone"></i> Клиент</div>
        <div class="row g-2 mb-1">
            <div class="col-12 col-md-6">
                <input type="text" id="o-phone" class="form-control form-control-sm" placeholder="Телефон клиента *" value="${client ? escapeHtml(client.phone) : ""}" ${isEdit ? "disabled" : ""}>
            </div>
            <div class="col-12 col-md-6"><span id="o-client-info" class="small-note"></span></div>
        </div>
        ${!isEdit ? `<button type="button" class="btn-nav mb-3" id="o-find-client"><i class="bi bi-search"></i> Найти клиента</button>` : ""}
        <div id="o-address-box"></div>
        <div class="section-title"><i class="bi bi-box"></i> Что везём</div>
        <textarea id="o-items" class="form-control" rows="5" placeholder="Например:\nКреветки 1 кг\nКальмар 0,5 кг\nИтого 3400">${order ? escapeHtml(order.items) : ""}</textarea>
        <button type="button" class="btn-nav mt-2" id="o-parse"><i class="bi bi-magic"></i> Распознать и посчитать</button>
        <div id="o-parse-result" class="mt-2"></div>
        <div class="row g-2 mt-2">
            <div class="col-6 col-md-3">
                <label class="field-label">Дата доставки *</label>
                <input type="date" id="o-date" class="form-control form-control-sm" value="${order ? order.date : state.currentDate}">
            </div>
            <div class="col-6 col-md-3">
                <label class="field-label">Оплата</label>
                <select id="o-payment" class="form-select form-select-sm">
                    <option value="" ${order && !order.payment_status ? "selected" : ""}>—</option>
                    <option value="Оплачено" ${order && order.payment_status === "Оплачено" ? "selected" : ""}>Оплачено</option>
                    <option value="Не оплачено" ${order && order.payment_status === "Не оплачено" ? "selected" : ""}>Не оплачено</option>
                    <option value="Выигрыш" ${order && order.payment_status === "Выигрыш" ? "selected" : ""}>Выигрыш</option>
                </select>
            </div>
            <div class="col-6 col-md-3">
                <label class="field-label">Сумма, руб.</label>
                <input type="number" id="o-amount" class="form-control form-control-sm" value="${order ? order.amount : ""}" ${order && order.payment_status === "Выигрыш" ? "disabled" : ""}>
            </div>
            ${isEdit ? `
            <div class="col-6 col-md-3">
                <label class="field-label">Статус</label>
                <select id="o-status" class="form-select form-select-sm">
                    ${Object.entries(STATUS_META).map(([k, v]) => `<option value="${k}" ${order.status === k ? "selected" : ""}>${v.label}</option>`).join("")}
                </select>
            </div>` : ""}
            <div class="col-12">
                <label class="field-label">Комментарий курьера</label>
                <input type="text" id="o-comment" class="form-control form-control-sm" value="${order ? escapeHtml(order.comment || "") : ""}">
            </div>
        </div>
    `, `
        <button class="btn btn-cancel" data-bs-dismiss="modal">Отмена</button>
        <button class="btn btn-primary" id="o-save"><i class="bi bi-check2-circle me-1"></i> ${isEdit ? "Сохранить" : "Добавить в журнал"}</button>
    `);

    const renderAddressBox = () => {
        const box = document.getElementById("o-address-box");
        if (!client) { box.innerHTML = `<div class="small-note mb-2">Клиент не выбран — введите телефон и нажмите «Найти клиента».</div>`; return; }
        box.innerHTML = `<label class="field-label">Адрес доставки *</label>` + client.addresses.map((a) => `
            <div class="form-check mb-1">
                <input class="form-check-input" type="radio" name="o-addr" value="${a.id}" id="o-addr-${a.id}" ${a.id === addressId ? "checked" : ""}>
                <label class="form-check-label" for="o-addr-${a.id}">${escapeHtml(addressFull(a))}${a.notes ? " — " + escapeHtml(a.notes) : ""}</label>
            </div>`).join("");
    };

    const updateClientInfo = () => {
        if (!client) { document.getElementById("o-client-info").textContent = ""; return; }
        let extra = client.name ? client.name : "Без имени";
        if (client.phone_extra) extra += ` · доп. ${client.phone_extra}`;
        document.getElementById("o-client-info").textContent = extra;
    };

    if (client) { renderAddressBox(); updateClientInfo(); } else renderAddressBox();

    if (!isEdit) {
        document.getElementById("o-find-client").addEventListener("click", () => {
            const found = findClientByPhone(document.getElementById("o-phone").value);
            if (!found) return toast(`Клиент не найден в базе`, "err");
            client = found;
            addressId = client.addresses.length ? client.addresses[0].id : null;
            document.getElementById("o-phone").value = client.phone;
            renderAddressBox(); updateClientInfo();
        });
    }

    document.getElementById("o-payment").addEventListener("change", (e) => {
        const amount = document.getElementById("o-amount");
        if (e.target.value === "Выигрыш") { amount.value = ""; amount.disabled = true; }
        else { amount.disabled = false; }
    });

    document.getElementById("o-parse").addEventListener("click", () => {
        const textArea = document.getElementById("o-items");
        const text = textArea.value;
        const paymentSelect = document.getElementById("o-payment");
        const amountInput = document.getElementById("o-amount");
        const textLower = text.toLowerCase();

        // Автостатус
        const payStatus = detectPaymentStatus(textLower);
        if (payStatus) {
            paymentSelect.value = payStatus;
            if (payStatus === "Выигрыш") { amountInput.value = ""; amountInput.disabled = true; }
            else { amountInput.disabled = false; }
        }

        const result = parseOrderText(text, priceDict());
        const box = document.getElementById("o-parse-result");

        if (!result.results.length) { box.innerHTML = `<div class="small-note text-danger">Товары не распознаны.</div>`; return; }

        box.innerHTML = `
            <div class="custom-card mb-0">
                <table class="table table-sm mb-0">
                    <thead><tr><th>Товар</th><th style="width:110px">Кол-во</th><th style="width:100px">Цена</th><th style="width:90px">Сумма</th></tr></thead>
                    <tbody>
                    ${result.results.map((r, idx) => `
                        <tr>
                            <td class="align-middle">${escapeHtml(r.name)} ${r.isFuzzy ? ` <span class="badge-custom">≈</span>` : ""} ${r.isWin ? ` <span class="badge bg-warning text-dark" style="font-size:10px; padding: 2px 6px;">Выигрыш</span>` : ""}</td>
                            <td><div class="d-flex align-items-center gap-1"><input type="number" step="0.1" class="form-control form-control-sm parse-qty" data-idx="${idx}" value="${r.qty}" style="width:60px"><span class="small text-muted">${escapeHtml(r.type)}</span></div></td>
                            <td><input type="number" class="form-control form-control-sm parse-price" data-idx="${idx}" value="${r.price}" style="width:80px"></td>
                            <td class="align-middle"><b class="parse-sum" data-idx="${idx}">${formatMoney(r.sum)}</b></td>
                        </tr>`).join("")}
                    </tbody>
                    <tfoot><tr><td colspan="3" class="text-end"><b>Итого:</b></td><td><b id="parse-final-total">${formatMoney(result.finalTotal)}</b></td></tr></tfoot>
                </table>
            </div>
            <button type="button" class="btn-nav mt-2" id="o-apply-total"><i class="bi bi-cash-coin"></i> Подставить сумму: <span>${formatMoney(result.finalTotal)}</span></button>
        `;

        const recalcParseTotal = () => {
            let total = 0;
            box.querySelectorAll('tbody tr').forEach(tr => {
                const isWinRow = tr.querySelector('.badge.bg-warning') !== null;
                let sum = 0;
                if (!isWinRow) {
                    const qty = parseFloat(tr.querySelector('.parse-qty').value) || 0;
                    const price = parseFloat(tr.querySelector('.parse-price').value) || 0;
                    sum = Math.round(qty * price);
                }
                tr.querySelector('.parse-sum').textContent = formatMoney(sum);
                total += sum;
            });
            box.querySelector('#parse-final-total').textContent = formatMoney(total);
            const applyBtn = box.querySelector('#o-apply-total');
            if (applyBtn) applyBtn.innerHTML = `<i class="bi bi-cash-coin"></i> Подставить сумму: <span>${formatMoney(total)}</span>`;
            return total;
        };

        box.querySelectorAll('.parse-qty, .parse-price').forEach(input => input.addEventListener('input', recalcParseTotal));

        document.getElementById("o-apply-total").addEventListener("click", () => {
            const finalSum = recalcParseTotal();
            document.getElementById("o-amount").value = finalSum;
            
            let newText = "";
            box.querySelectorAll('tbody tr').forEach(tr => {
                const name = tr.querySelector('td').childNodes[0].textContent.trim();
                const qty = tr.querySelector('.parse-qty').value;
                const type = tr.querySelector('td:nth-child(2) .small').textContent.trim();
                const isWin = tr.querySelector('.badge.bg-warning') !== null;
                newText += `${name} ${qty}${type}${isWin ? ' (выигрыш)' : ''}\n`;
            });
            textArea.value = newText.trim();
            toast("Сумма и текст обновлены!", "ok");
        });
    });

    document.getElementById("o-save").addEventListener("click", () => {
        if (!client) return toast("Найдите клиента", "err");
        const addrRadio = document.querySelector('input[name="o-addr"]:checked');
        let items = document.getElementById("o-items").value.trim();
        const dateStr = parseDateString(document.getElementById("o-date").value);
        if (!addrRadio || !items || !dateStr) return toast("Заполните все поля", "err");

        const paymentSelect = document.getElementById("o-payment");
        let payment = paymentSelect.value;

        // Очистка при сохранении
        const textLower = items.toLowerCase();
        if (textLower.includes("опл") || textLower.includes("наличка")) {
            payment = textLower.includes("не опл") ? "Не оплачено" : "Оплачено";
        } else if (textLower.includes("выигрыш") && payment === "") {
            payment = "Выигрыш";
        }
        paymentSelect.value = payment;
        items = cleanItemsText(items);
        document.getElementById("o-items").value = items;

        const amount = payment === "Выигрыш" ? 0 : parseInt(document.getElementById("o-amount").value, 10) || 0;
        const comment = document.getElementById("o-comment").value;
        const addrId = parseInt(addrRadio.value, 10);

        if (isEdit) {
            order.address_id = addrId;
            order.items = items;
            order.comment = comment;
            order.date = dateStr;
            order.payment_status = payment;
            order.amount = amount;
            order.status = document.getElementById("o-status").value;
            order.updated_at = new Date().toISOString();
            toast("✅ Заказ успешно обновлён!", "ok");
        } else {
            state.db.orders.push({
                id: newId("order"), client_id: client.id, address_id: addrId, date: dateStr,
                items, status: "new", comment, payment_status: payment, amount,
                created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            });
            toast(`✅ Доставка добавлена на ${fmtDate(dateStr)}!`, "ok");
            state.currentDate = dateStr;
        }
        persist();
        closeModal();
        showScreen("journal");
    });
}

// ---------------------------------------------------------------------------
// Импорт доставок
// ---------------------------------------------------------------------------

function openImportModal() {
    showModal("Импорт доставок", `
        <div class="alert alert-info py-2 small">Вставьте список заказов или загрузите файл .txt / .csv.</div>
        <div class="row g-2 mb-2">
            <div class="col-12 col-md-4"><label class="field-label">Дата *</label><input type="date" id="i-date" class="form-control form-control-sm" value="${state.currentDate}"></div>
            <div class="col-12 col-md-8"><label class="field-label">Файл (.txt / .csv)</label><input type="file" id="i-file" class="form-control form-control-sm" accept=".txt,.csv"></div>
        </div>
        <label class="field-label">Или вставьте текст</label>
        <textarea id="i-text" class="form-control" rows="10" style="font-family:monospace; font-size:13px"></textarea>
    `, `
        <button class="btn btn-cancel" data-bs-dismiss="modal">Отмена</button>
        <button class="btn btn-primary" id="i-go"><i class="bi bi-magic me-1"></i> Распознать и добавить</button>
    `);

    document.getElementById("i-file").addEventListener("change", async (e) => {
        const file = e.target.files[0]; if (!file) return;
        document.getElementById("i-text").value = await file.text();
    });

    document.getElementById("i-go").addEventListener("click", () => {
        const rawText = document.getElementById("i-text").value;
        const dateStr = parseDateString(document.getElementById("i-date").value);
        if (!rawText || !dateStr) return toast("Загрузите файл или вставьте текст, и укажите дату.", "err");
        runImport(rawText, dateStr);
    });
}

function runImport(rawText, dateStr) {
    let added = 0, updated = 0;
    const notFound = [], noAddress = [];

    for (const entry of splitImportText(rawText)) {
        const client = findClientByPhone(entry.phone);
        if (!client) { notFound.push(canonicalPhone(entry.phone)); continue; }
        const address = client.addresses[0];
        if (!address) { noAddress.push(canonicalPhone(entry.phone)); continue; }

        const fields = buildOrderFromImportEntry(entry);
        const existing = state.db.orders.find((o) => o.client_id === client.id && o.date === dateStr);
        
        if (existing) {
            existing.address_id = address.id; existing.items = fields.items;
            existing.payment_status = fields.payment_status; existing.amount = fields.amount;
            existing.updated_at = new Date().toISOString(); updated++;
        } else {
            state.db.orders.push({
                id: newId("order"), client_id: client.id, address_id: address.id, date: dateStr,
                items: fields.items, status: "new", comment: "", payment_status: fields.payment_status, amount: fields.amount,
                created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            });
            added++;
        }
    }

    persist(); closeModal();
    if (added) toast(`✅ Добавлено: ${added}`, "ok");
    if (updated) toast(`🔄 Обновлено: ${updated}`, "warn");
    if (notFound.length) toast(`⚠️ Не найдены: ${notFound.slice(0, 5).join(", ")}`, "err");
    if (noAddress.length) toast(`⚠️ Нет адреса у: ${noAddress.join(", ")}`, "err");
    state.currentDate = dateStr;
    showScreen("journal");
}

// ---------------------------------------------------------------------------
// Прайс-лист
// ---------------------------------------------------------------------------

function renderPrices() {
    const q = state.priceSearch.trim().toLowerCase();
    let products = state.db.products.slice();
    if (q) products = products.filter((p) => p.name.toLowerCase().includes(q) || (p.category || "").toLowerCase().includes(q));
    products.sort((a, b) => (a.category || "").localeCompare(b.category || "ru") || a.name.localeCompare(b.name, "ru"));

    const groups = {};
    for (const p of products) { const cat = p.category || "Разное"; (groups[cat] = groups[cat] || []).push(p); }
    const categoryOrder = Object.keys(groups).sort((a, b) => a.localeCompare(b, "ru"));

    let body = "";
    for (const cat of categoryOrder) {
        body += `<div class="category-header"><i class="bi bi-tag me-2"></i>${escapeHtml(cat)} <span class="ms-auto small">${groups[cat].length}</span></div>`;
        body += `<div class="table-responsive"><table class="table">
            <thead><tr><th>Название</th><th>Цена, руб.</th><th>Ед. изм.</th><th>Синонимы</th><th style="width:90px"></th></tr></thead>
            <tbody>
            ${groups[cat].map((p) => `
                <tr>
                    <td><b>${escapeHtml(p.name)}</b></td><td>${formatMoney(p.price)}</td><td>${escapeHtml(p.unit || "")}</td><td class="small-note">${escapeHtml(p.synonyms || "")}</td>
                    <td class="text-nowrap">
                        <button class="btn-action edit" data-act="product-edit" data-id="${p.id}"><i class="bi bi-pencil"></i></button>
                        <button class="btn-action fail" data-act="product-delete" data-id="${p.id}"><i class="bi bi-trash"></i></button>
                    </td>
                </tr>`).join("")}
            </tbody>
        </table></div>`;
    }
    if (!categoryOrder.length) body = `<div class="empty-state">Товаров не найдено. Добавьте первый.</div>`;

    document.getElementById("screen").innerHTML = `
        <div class="custom-card">
            <div class="custom-card-header">
                <div class="d-flex align-items-center gap-3"><span><i class="bi bi-tags me-2"></i>Прайс-лист</span><span class="count-badge">${products.length}</span></div>
                <div class="d-flex align-items-center gap-2">
                    <div class="search-wrapper"><i class="bi bi-search"></i><input type="text" id="price-search" class="form-control search-input" style="max-width:220px" placeholder="Поиск по прайсу..." value="${escapeHtml(state.priceSearch)}"></div>
                    <button class="btn-nav" id="add-product-btn"><i class="bi bi-plus-lg"></i> Добавить</button>
                </div>
            </div>
            ${body}
        </div>`;

    document.getElementById("add-product-btn").addEventListener("click", () => openProductModal());
    const search = document.getElementById("price-search");
    let timer = null;
    search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { state.priceSearch = search.value; renderPrices(); }, 250); });
    for (const btn of document.querySelectorAll('[data-act="product-edit"]')) {
        btn.addEventListener("click", () => openProductModal(state.db.products.find((p) => p.id === parseInt(btn.dataset.id, 10))));
    }
    for (const btn of document.querySelectorAll('[data-act="product-delete"]')) {
        btn.addEventListener("click", () => {
            const p = state.db.products.find((x) => x.id === parseInt(btn.dataset.id, 10));
            if (!p || !confirmAction(`Удалить товар «${p.name}»?`)) return;
            state.db.products = state.db.products.filter((x) => x.id !== p.id);
            persist(); toast("Товар удалён.", "ok"); renderPrices();
        });
    }
}

function openProductModal(product) {
    const isEdit = !!product;
    const categories = [...new Set(state.db.products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
    showModal(isEdit ? "Редактировать товар" : "Добавить товар", `
        <div class="row g-2 mt-1">
            <div class="col-12 col-md-6"><label class="field-label">Название *</label><input type="text" id="p-name" class="form-control form-control-sm" value="${product ? escapeHtml(product.name) : ""}"></div>
            <div class="col-6 col-md-3"><label class="field-label">Цена</label><input type="number" id="p-price" class="form-control form-control-sm" value="${product ? product.price : ""}"></div>
            <div class="col-6 col-md-3"><label class="field-label">Ед. изм.</label><input type="text" id="p-unit" class="form-control form-control-sm" placeholder="кг, шт" value="${product ? escapeHtml(product.unit || "") : ""}"></div>
            <div class="col-12 col-md-4"><label class="field-label">Категория</label><input type="text" id="p-category" class="form-control form-control-sm" list="cats-datalist" value="${product ? escapeHtml(product.category || "Разное") : ""}"><datalist id="cats-datalist">${categories.map((c) => `<option value="${escapeHtml(c)}">`).join("")}</datalist></div>
            <div class="col-12 col-md-8"><label class="field-label">Синонимы (через запятую)</label><input type="text" id="p-synonyms" class="form-control form-control-sm" value="${product ? escapeHtml(product.synonyms || "") : ""}"></div>
        </div>
    `, `
        <button class="btn btn-cancel" data-bs-dismiss="modal">Отмена</button>
        <button class="btn btn-primary" id="p-save"><i class="bi bi-check2-circle me-1"></i> Сохранить</button>
    `);
    document.getElementById("p-save").addEventListener("click", () => {
        const name = document.getElementById("p-name").value.trim();
        if (!name) return toast("Укажите название", "err");
        const data = { name, price: parseInt(document.getElementById("p-price").value, 10) || 0, unit: document.getElementById("p-unit").value.trim(), category: document.getElementById("p-category").value.trim() || "Разное", synonyms: document.getElementById("p-synonyms").value };
        if (isEdit) Object.assign(product, data);
        else state.db.products.push(Object.assign({ id: newId("product") }, data));
        persist(); toast(isEdit ? "Товар обновлён!" : "Товар добавлен!", "ok"); closeModal(); renderPrices();
    });
}

// ---------------------------------------------------------------------------
// Дубли
// ---------------------------------------------------------------------------

function findDuplicateGroups() {
    const groups = {};
    for (const c of state.db.clients) {
        const key = canonicalPhone(c.phone).slice(-10);
        if (!key) continue;
        (groups[key] = groups[key] || []).push(c);
    }
    const result = [];
    for (const members of Object.values(groups)) {
        if (members.length < 2) continue;
        members.sort((a, b) => a.id - b.id);
        const enriched = members.map((c) => ({ client: c, orders_count: state.db.orders.filter((o) => o.client_id === c.id).length, addresses_count: c.addresses.length }));
        const rec = enriched.reduce((best, m) => { const score = (m) => m.orders_count * 100 + m.addresses_count * 10 + m.client.id; return score(m) > score(best) ? m : best; });
        result.push({ phone_display: members[0].phone, members: enriched, recommended_pk: rec.client.id });
    }
    result.sort((a, b) => a.phone_display.localeCompare(b.phone_display, "ru"));
    return result;
}

function findLinkedPhones() {
    const byKey = {};
    for (const c of state.db.clients) { const key = canonicalPhone(c.phone).slice(-10); if (key) byKey[key] = c; }
    const linked = [], seen = new Set();
    for (const c of state.db.clients) {
        const own = canonicalPhone(c.phone).slice(-10), extra = canonicalPhone(c.phone_extra).slice(-10);
        if (!extra || extra === own) continue;
        const other = byKey[extra];
        if (other && other.id !== c.id) {
            const pair = [c.id, other.id].sort().join("-");
            if (seen.has(pair)) continue; seen.add(pair); linked.push({ owner: c, other });
        }
    }
    return linked.slice(0, 20);
}

function renderDuplicates() {
    const groups = findDuplicateGroups(), linked = findLinkedPhones();
    const groupHtml = groups.map((g) => `
        <div class="custom-card dup-group">
            <div class="custom-card-header"><span><i class="bi bi-telephone-outbound me-2"></i>${escapeHtml(g.phone_display)}</span><span class="count-badge">${g.members.length} зап.</span></div>
            <form data-group-form>
                ${g.members.map((m) => dupMemberRow(g, m)).join("")}
                <div class="card-footer-bar"><small class="me-auto">Останется выбранный клиент — к нему переносятся адреса, заказы и заметки.</small><button type="submit" class="btn btn-primary"><i class="bi bi-arrow-down-up me-1"></i> Объединить</button></div>
            </form>
        </div>`).join("");
    const linkedHtml = linked.length ? `
        <div class="custom-card">
            <div class="custom-card-header"><span><i class="bi bi-link-45deg me-2"></i>Связанные номера</span><span class="count-badge">${linked.length}</span></div>
            ${linked.map((p) => `<div class="dup-member"><div class="flex-grow-1"><div class="dup-name">${escapeHtml(p.owner.name || "Без имени")} <span class="text-muted small" style="font-weight:400">— доп. тел. ${escapeHtml(p.owner.phone_extra)}</span></div><div class="dup-phones"><span><i class="bi bi-telephone"></i>Совпадает с клиентом: ${escapeHtml(p.other.name || "Без имени")} (${escapeHtml(p.other.phone)})</span></div></div></div>`).join("")}
        </div>` : "";

    document.getElementById("screen").innerHTML = `
        <div class="page-header"><div class="icon-box"><i class="bi bi-arrow-down-up"></i></div><div><h5>Дубли телефонов</h5><div class="sub">Найдено групп: ${groups.length}</div></div></div>
        ${groupHtml || `<div class="custom-card"><div class="empty-state"><i class="bi bi-emoji-smile fs-2 d-block mb-2 icon-primary"></i>Дубликатов не найдено.</div></div>`}
        ${linkedHtml}`;

    for (const form of document.querySelectorAll("[data-group-form]")) {
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            const keep = form.querySelector('input[name="keep_id"]:checked');
            const mergeIds = [...form.querySelectorAll('input[name="merge_ids"]:checked')].map((cb) => parseInt(cb.value, 10));
            if (!keep) return toast("Выберите главного клиента", "err");
            mergeClients(parseInt(keep.value, 10), mergeIds);
        });
    }
}

function dupMemberRow(group, m) {
    const c = m.client, isRec = c.id === group.recommended_pk;
    return `
        <div class="dup-member ${isRec ? "keep" : ""}">
            <div class="dup-choice"><input class="form-check-input" type="radio" name="keep_id" value="${c.id}" ${isRec ? "checked" : ""}></div>
            <div class="flex-grow-1">
                <div class="dup-name">${escapeHtml(c.name || "Без имени")}${m.orders_count ? ` <span class="count-badge">${m.orders_count} зак.</span>` : ""}</div>
                <div class="dup-phones"><span><i class="bi bi-telephone"></i>${escapeHtml(c.phone)}</span>${c.phone_extra ? `<span><i class="bi bi-telephone-inbound"></i>${escapeHtml(c.phone_extra)}</span>` : ""}</div>
                <div class="dup-addresses">${c.addresses.length ? c.addresses.map((a) => `<span><i class="bi bi-geo-alt"></i>${escapeHtml(a.street)}, д. ${escapeHtml(a.house)}${a.apartment ? ", кв. " + escapeHtml(a.apartment) : ""}</span>`).join("") : "<span>Адресов нет</span>"}</div>
            </div>
            <div class="form-check"><input class="form-check-input" type="checkbox" name="merge_ids" value="${c.id}" ${!isRec ? "checked" : ""}><label class="form-check-label small text-muted">объединить</label></div>
        </div>`;
}

function mergeClients(keepId, mergeIds) {
    mergeIds = mergeIds.filter((id) => id !== keepId);
    const keep = findClient(keepId), others = mergeIds.map((id) => findClient(id)).filter(Boolean);
    if (!keep || !others.length) return toast("Ошибка выбора клиентов", "err");
    if (!confirmAction(`Объединить ${others.length} записей в «${keep.name || keep.phone}»? Это действие нельзя отменить.`)) return;

    for (const field of ["name", "phone_extra", "phone_extra_name", "notes"]) {
        if (!(keep[field] || "").trim()) {
            for (const other of others) { const value = (other[field] || "").trim(); if (value) { keep[field] = value; break; } }
        }
    }
    keep.phone = canonicalPhone(keep.phone);

    const seen = new Set(keep.addresses.map(addrKey));
    let movedAddresses = 0;
    for (const other of others) {
        for (const a of other.addresses) {
            const k = addrKey(a); if (seen.has(k)) continue;
            seen.add(k); keep.addresses.push(a); movedAddresses++;
        }
    }

    const otherIds = others.map((o) => o.id);
    let movedOrders = 0;
    for (const o of state.db.orders) { if (otherIds.includes(o.client_id)) { o.client_id = keep.id; movedOrders++; } }
    state.db.clients = state.db.clients.filter((c) => !otherIds.includes(c.id));
    persist();
    toast(`✅ Объединено: ${others.length} зап. Перенесено: адресов — ${movedAddresses}, заказов — ${movedOrders}.`, "ok");
    renderDuplicates();
}

// ---------------------------------------------------------------------------
// Экран: Данные (Только локальные бэкапы)
// ---------------------------------------------------------------------------

function exportJson() {
    downloadJson("database.json", JSON.stringify(state.db, null, 2));
    state.isDirty = false;
    updateBackupWarning();
    toast("✅ Резервная копия скачана! Теперь можно закрывать.", "ok");
}

function renderData() {
    const db = state.db;
    document.getElementById("screen").innerHTML = `
        <div class="custom-card">
            <div class="custom-card-header"><span><i class="bi bi-info-circle me-2"></i>База</span><span class="count-badge">${db.clients.length} клик. · ${db.orders.length} зак. · ${db.products.length} тов.</span></div>
            <div class="p-3 small-note">Последнее изменение: ${db.meta.updated_at ? new Date(db.meta.updated_at).toLocaleString("ru-RU") : "—"}. Данные сохраняются в этом браузере (localStorage).</div>
        </div>

        <div class="custom-card">
            <div class="custom-card-header"><span><i class="bi bi-shield-lock me-2"></i>Резервные копии</span></div>
            <div class="card-body p-3">
                <div class="d-flex gap-2 flex-wrap mb-2">
                    <button class="btn-nav" id="export-json"><i class="bi bi-download"></i> Скачать базу (JSON)</button>
                    <label class="btn-nav mb-0" for="import-json-file"><i class="bi bi-upload"></i> Загрузить базу (JSON)</label>
                    <input type="file" id="import-json-file" accept=".json" style="display:none">
                </div>
                <div class="small-note">Регулярно скачивайте базу — это ваша страховка от сбоя браузера. Файл можно перенести на другой компьютер.</div>
            </div>
        </div>`;

    document.getElementById("export-json").addEventListener("click", exportJson);
    document.getElementById("import-json-file").addEventListener("change", async (e) => {
        const file = e.target.files[0]; if (!file) return;
        try {
            state.db = migrateDb(JSON.parse(await file.text()));
            state.isDirty = false;
            updateBackupWarning();
            persist(); toast("База загружена из файла.", "ok"); renderData();
        } catch (err) { toast("Ошибка JSON: " + err.message, "err"); }
    });
}

// ---------------------------------------------------------------------------
// Экспорт / импорт CSV
// ---------------------------------------------------------------------------

function exportCsv() {
    const rows = [["Телефон", "Имя", "Доп. телефон", "Кому принадлежит", "Улица", "Дом", "Кв", "Подъезд"]];
    for (const { client: c, address: a } of allAddresses()) rows.push([c.phone, c.name, c.phone_extra, c.phone_extra_name, a.street, a.house, a.apartment, a.entrance]);
    const csv = "\ufeff" + rows.map((r) => r.map((v) => (v == null ? "" : String(v).replace(/"/g, '""'))).join(";")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "baza_dostavok.csv"; a.click(); URL.revokeObjectURL(url);
}

function importCsvDialog() {
    showModal("Импорт CSV", `
        <div class="alert alert-warning py-2 small">Формат: Телефон; Имя; Доп. телефон; Кому принадлежит; Улица; Дом; Кв; Подъезд.</div>
        <input type="file" id="csv-file" class="form-control" accept=".csv,.txt">
    `, `
        <button class="btn btn-cancel" data-bs-dismiss="modal">Отмена</button>
        <button class="btn btn-primary" id="csv-go"><i class="bi bi-upload me-1"></i> Импортировать</button>
    `);

    document.getElementById("csv-go").addEventListener("click", async () => {
        const file = document.getElementById("csv-file").files[0];
        if (!file) return toast("Выберите файл", "err");
        let text = await file.text();
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const lines = text.split(/\r?\n/);
        const delimiter = lines[0] && lines[0].includes(";") ? ";" : ",";
        let added = 0, skipped = 0;

        for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.split(delimiter).map((p) => p.trim().replace(/^"|"$/g, ""));
            const phone = canonicalPhone(parts[0]);
            if (!phone || phone.length < 10) continue;
            if (findClientByPhone(phone)) { skipped++; continue; }
            const street = (parts[4] || "").trim();
            if (!street) continue;

            state.db.clients.push({
                id: newId("client"), phone, name: parts[1] || "", phone_extra: canonicalPhone(parts[2] || ""), phone_extra_name: parts[3] || "", notes: "",
                addresses: [{ id: newId("address"), street, house: parts[5] || "-", apartment: parts[6] || "", entrance: parts[7] || "", floor: "", intercom: "", notes: "" }],
            });
            added++;
        }
        persist(); closeModal(); toast(`✅ Добавлено: ${added}. Пропущено: ${skipped}.`, "ok"); renderClients();
    });
}

// ---------------------------------------------------------------------------
// Напоминание о резервной копии
// ---------------------------------------------------------------------------

function updateBackupWarning() {
    let warningBox = document.getElementById("backup-warning");
    
    if (state.isDirty) {
        if (!warningBox) {
            warningBox = document.createElement("div");
            warningBox.id = "backup-warning";
            warningBox.style.cssText = "position: fixed; top: 70px; left: 50%; transform: translateX(-50%); background: #dc2626; color: white; padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: 600; z-index: 1000; box-shadow: 0 4px 12px rgba(220,38,38,0.4); cursor: pointer; display: flex; align-items: center; gap: 8px; animation: toast-in 0.3s ease;";
            warningBox.innerHTML = `<i class="bi bi-exclamation-triangle-fill"></i> Данные не сохранены в файл. Нажмите, чтобы скачать!`;
            warningBox.onclick = () => {
                exportJson(); // Теперь функция существует
            };
            document.body.appendChild(warningBox);
        }
    } else {
        if (warningBox) warningBox.remove();
    }
}

// Предупреждение при закрытии вкладки
window.addEventListener("beforeunload", (e) => {
    if (state.isDirty) {
        e.preventDefault();
        e.returnValue = ""; // Браузер покажет стандартное окно "Изменения могут не сохраниться"
    }
});

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------

function init() {
    if (!loadFromStorage()) {
        state.db = emptyDb();
    }
    renderTabs();
    showScreen("clients");
}

document.addEventListener("DOMContentLoaded", init);