"use strict";
// ============================================================
// parse.js — порты логики распознавания из Django-версии
// ============================================================

function normalizePhone(value) {
    return (value || "").replace(/\D/g, "");
}

function canonicalPhone(value) {
    let p = normalizePhone(value);
    if (p.length === 11 && p.startsWith("7")) p = "8" + p.slice(1);
    return p;
}

const PHONE_REGEX_SOURCE = "(?:\\+7|8)[\\s\\-.]*(?:\\(\\d{3}\\)?[\\s\\-.]*)?\\d{3}[\\s\\-.]*\\d{3}[\\s\\-.]*\\d{2}[\\s\\-.]*\\d{2}|\\d{10}";

function findPhones(text) {
    const found = [];
    const re = new RegExp(PHONE_REGEX_SOURCE, "g");
    let m;
    while ((m = re.exec(text)) !== null) {
        const before = m.index > 0 ? text[m.index - 1] : "";
        const end = m.index + m[0].length;
        const after = end < text.length ? text[end] : "";
        if (/\d/.test(before) || /\d/.test(after)) {
            re.lastIndex = m.index + 1;
            continue;
        }
        found.push({ phone: m[0], index: m.index, length: m[0].length });
    }
    return found;
}

function parseDateString(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    return m ? value : null;
}

function fmtDate(ymd) {
    if (!ymd) return "";
    const [y, m, d] = ymd.split("-");
    return `${d}.${m}.${y.slice(2)}`;
}

function todayYmd() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDate(ymd, days) {
    const d = new Date(ymd + "T12:00:00");
    d.setDate(d.getDate() + days);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function weekdayRu(ymd) {
    const names = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
    return names[new Date(ymd + "T12:00:00").getDay()];
}

function normalizeText(text) {
    return (text || "")
        .toLowerCase()
        .replace(/ё/g, "е")
        .replace(/[₽]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const m = [];
    for (let i = 0; i <= b.length; i++) m[i] = [i];
    for (let j = 0; j <= a.length; j++) m[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            m[i][j] = b.charAt(i - 1) === a.charAt(j - 1)
                ? m[i - 1][j - 1]
                : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
        }
    }
    return m[b.length][a.length];
}

function normProduct(s) {
    return (s || "").toLowerCase().replace(/ё/g, "е").trim();
}

function findAllProducts(text, priceDict) {
    let matches = [];
    for (const [name, info] of Object.entries(priceDict)) {
        const candidates = [name, ...(info.synonyms || [])].map(normProduct);
        for (const cand of candidates) {
            if (!cand || cand.length < 3) continue;
            let idx = text.indexOf(cand);
            while (idx !== -1) {
                matches.push({ name, info, matched: cand, index: idx, length: cand.length });
                idx = text.indexOf(cand, idx + cand.length);
            }
        }
    }
    matches.sort((a, b) => a.index - b.index || b.length - a.length);
    const validMatches = [];
    let lastEnd = -1;
    for (const m of matches) {
        if (m.index >= lastEnd) {
            validMatches.push(m);
            lastEnd = m.index + m.length;
        }
    }
    return validMatches;
}

function findProduct(text, priceDict) {
    let best = null;
    let bestLen = 0;
    for (const [name, info] of Object.entries(priceDict)) {
        const candidates = [name, ...(info.synonyms || [])].map(normProduct);
        for (const cand of candidates) {
            if (!cand || cand.length < 2) continue;
            if (text.includes(cand) && cand.length > bestLen) {
                best = { name, info, matched: cand };
                bestLen = cand.length;
            }
        }
    }
    if (!best) {
        const cleanText = text.replace(/[^\u0430-\u044Fa-zA-Z]/g, " ");
        const words = cleanText.split(/\s+/).filter((w) => w.length >= 4);
        for (const word of words) {
            for (const [name, info] of Object.entries(priceDict)) {
                const candidates = [name, ...(info.synonyms || [])].map(normProduct);
                for (const cand of candidates) {
                    const candFirst = cand.split(" ")[0].replace(/[^\u0430-\u044Fa-zA-Z]/g, "");
                    if (!candFirst || candFirst.length < 4) continue;
                    
                    // А) Поиск по корню: "краб" находит "крабовое"
                    if (candFirst.startsWith(word) || word.startsWith(candFirst)) {
                        if (candFirst.length > bestLen) {
                            best = { name, info, matched: word, isFuzzy: true };
                            bestLen = candFirst.length;
                        }
                    } 
                    // Б) Поиск по опечаткам
                    else {
                        const maxDist = word.length <= 5 ? 1 : 2;
                        if (levenshtein(word, candFirst) <= maxDist && candFirst.length > bestLen) {
                            best = { name, info, matched: word, isFuzzy: true };
                            bestLen = candFirst.length;
                        }
                    }
                }
            }
        }
    }
    return best;
}

function extractQuantity(text, productName, unit) {
    const nameLower = normProduct(productName);

    if (nameLower.includes("рожк")) {
        let m = text.match(/(\d+)\s*рожк/);
        if (m) return { qty: parseInt(m[1], 10) / 10, type: "уп (10шт)" };
        m = text.match(/(\d+)\s*(?:шт|уп)/);
        if (m) return { qty: parseInt(m[1], 10) / 10, type: "уп (10шт)" };
    }

    const nameNumbers = nameLower.match(/(\d+[.,]?\d*)/g) || [];

    if (unit === "кг") {
        const kgMatch = text.match(/(\d+[.,]?\d*)\s*(?:кг|kg)/);
        if (kgMatch) return { qty: parseFloat(kgMatch[1].replace(",", ".")), type: "кг" };

        let textCopy = text;
        for (const nw of nameNumbers) {
            textCopy = textCopy.replace(new RegExp(nw.replace(".", "[.,]"), "g"), "");
        }
        const numMatch = textCopy.match(/(\d+[.,]?\d*)/);
        if (numMatch) return { qty: parseFloat(numMatch[1].replace(",", ".")), type: "кг" };
        return { qty: 1, type: "кг (по умолч.)" };
    }

    const pcsMatch = text.match(/(\d+)\s*(?:шт|уп)/);
    if (pcsMatch) return { qty: parseInt(pcsMatch[1], 10), type: "шт/уп" };

    let textCopy = text;
    for (const nw of nameNumbers) {
        textCopy = textCopy.replace(new RegExp(nw.replace(".", "[.,]"), "g"), "");
    }
    const numMatch = textCopy.match(/(\d+[.,]?\d*)/);
    if (numMatch) {
        let qty = parseFloat(numMatch[1].replace(",", "."));
        if (qty > 100) qty = 1;
        return { qty, type: "шт/уп" };
    }
    return { qty: 1, type: "1 (по умолч.)" };
}

function extractCourierTotal(text) {
    const m = text.match(/(?:итого|сумма)\s*:?\s*(\d{3,7})/i);
    return m ? parseInt(m[1], 10) : null;
}

function parseOrderText(rawText, priceDict) {
    const original = rawText || "";
    const lowerText = original.toLowerCase();

    // Проверяем, есть ли уже конкретные пометки "(выигрыш)" возле товаров
    const hasSpecificWin = lowerText.includes("(выигрыш)");
    const hasPaid = lowerText.includes("опл") || lowerText.includes("наличка");
    
    // ГЛОБАЛЬНЫЙ ВЫИГРЫШ: только если нет конкретных пометок, есть слово "выигрыш" и нет оплаты
    const isGlobalWin = !hasSpecificWin && lowerText.includes("выигрыш") && !hasPaid;

    let text = original.replace(/(?:итого|сумма)\s*:?\s*\d+/gi, "");
    const lines = text.split(/[\n;]+/).map(l => l.trim()).filter(l => l);

    const results = [];
    const notFound = [];
    let currentPrefix = "";

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        let lineLower = line.toLowerCase();

        // Если строка — это отдельно стоящий маркер выигрыша
        if (/^(выигрыш|\(выигрыш\))$/i.test(lineLower)) {
            if (results.length > 0) {
                results[results.length - 1].isWin = true;
                results[results.length - 1].sum = 0;
            }
            continue;
        }

        // Пропускаем маркеры оплаты
        if (/^(не\s*)?опл\S*$|^(наличка)$/i.test(lineLower)) continue;

        // Очищаем строку для поиска
        let searchText = lineLower.replace(/\(выигрыш\)|выигрыш\S*/gi, "").trim();
        searchText = searchText.replace(/(?:не\s*)?опл\S*|доплатить|наличка/gi, "").trim();
        if (!searchText) continue;

        // Если в этой конкретной строке есть пометка выигрыша
        const lineHasWin = lineLower.includes("выигрыш") || lineLower.includes("(выигрыш)");

        // Обработка префиксов (например, "Креветки: 1 кг")
        const colonIdx = searchText.indexOf(":");
        if (colonIdx !== -1) {
            const prefixCandidate = searchText.substring(0, colonIdx).trim();
            if (prefixCandidate.length > 0 && prefixCandidate.length < 20 && !/\d/.test(prefixCandidate)) {
                currentPrefix = prefixCandidate.replace(/ы$/, "").replace(/и$/, "").trim();
                searchText = searchText.substring(colonIdx + 1).trim();
                if (!searchText) continue;
            }
        }

        let textToSearch = searchText;
        if (currentPrefix && !textToSearch.includes(currentPrefix)) {
            textToSearch = currentPrefix + " " + textToSearch;
        }

        const normalizedSearch = normalizeText(textToSearch);
        const normalizedOriginal = normalizeText(searchText);

        const strictMatches = findAllProducts(normalizedSearch, priceDict);

        if (strictMatches.length > 0) {
            for (let j = 0; j < strictMatches.length; j++) {
                const found = strictMatches[j];
                const endIdx = j + 1 < strictMatches.length ? strictMatches[j + 1].index : normalizedSearch.length;
                const chunkAfter = normalizedSearch.substring(found.index + found.length, endIdx);
                const chunkBefore = j === 0 ? normalizedSearch.substring(0, found.index) : "";
                const chunk = chunkBefore + " " + chunkAfter;
                const { qty, type } = extractQuantity(chunk, found.name, found.info.unit);

                // Товар считается выигрышным, если это глобальный выигрыш ИЛИ пометка стоит в этой строке
                const isThisWin = isGlobalWin || lineHasWin;
                const sum = isThisWin ? 0 : Math.round(found.info.price * qty);

                results.push({
                    name: found.name, matched: found.matched, isFuzzy: false,
                    qty, type: type || found.info.unit, price: found.info.price,
                    sum: sum, isWin: isThisWin,
                });
            }
        } else {
            const found = findProduct(normalizedSearch, priceDict);
            if (found) {
                const { qty, type } = extractQuantity(normalizedOriginal, found.name, found.info.unit);
                const isThisWin = isGlobalWin || lineHasWin;
                const sum = isThisWin ? 0 : Math.round(found.info.price * qty);
                results.push({
                    name: found.name, matched: found.matched, isFuzzy: !!found.isFuzzy,
                    qty, type: type || found.info.unit, price: found.info.price,
                    sum: sum, isWin: isThisWin,
                });
            } else {
                notFound.push(line);
            }
        }
    }

    const itemsTotal = results.reduce((s, r) => s + r.sum, 0);
    const courierTotal = extractCourierTotal(original);
    const mismatch = courierTotal !== null && courierTotal !== itemsTotal ? itemsTotal - courierTotal : null;

    // Если хотя бы один товар платный, значит весь заказ не может быть "Выигрышем"
    const allAreWins = results.length > 0 && results.every(r => r.isWin);

    return {
        results, notFound, itemsTotal, courierTotal,
        isWin: isGlobalWin || allAreWins,
        finalTotal: courierTotal !== null ? courierTotal : itemsTotal,
        mismatch,
    };
}

function detectPaymentStatus(textLower) {
    const hasWin = textLower.includes("выигрыш");
    const hasPaid = textLower.includes("опл") || textLower.includes("наличка");
    
    if (hasWin && hasPaid) return "Оплачено";
    if (hasWin) return "Выигрыш";
    if (textLower.includes("не опл") || textLower.includes("неопл") || textLower.includes("доплатить") || textLower.includes("не оплачено")) return "Не оплачено";
    if (hasPaid || textLower.includes("оплачено")) return "Оплачено";
    return "";
}

function extractAmount(textLower, payStatus) {
    if (payStatus === "Выигрыш") return 0;
    const amountMatch = textLower.match(/(\d{3,6})\s*(?:руб|р\.|налич|итого|опл|не опл|доплатить)/);
    if (amountMatch) return parseInt(amountMatch[1], 10);
    const allNums = textLower.match(/\b\d{3,5}\b/g);
    return allNums ? parseInt(allNums[allNums.length - 1], 10) : 0;
}

function cleanItemsText(itemsText) {
    let text = itemsText.replace(/(?:✅|📍)/g, "");
    let lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    let cleanedLines = [];

    for (let line of lines) {
        let lower = line.toLowerCase();
        
        // Если отдельный маркер выигрыша — крепим к предыдущему
        if (/^(выигрыш|\(выигрыш\))$/i.test(lower)) {
            if (cleanedLines.length > 0) {
                cleanedLines[cleanedLines.length - 1] += " (выигрыш)";
            }
            continue;
        }
        
        // Удаляем маркеры оплаты
        if (/^(не\s*)?опл\S*$|^(наличка)$/i.test(lower)) continue;
        line = line.replace(/(?:не\s*)?опл\S*|доплатить|наличка/gi, "").trim();
        
        // Выигрыш в строке меняем на (выигрыш)
        line = line.replace(/выигрыш\S*/gi, "(выигрыш)").trim();
        line = line.replace(/^[\s,;.\-+]+|[\s,;.\-+]+$/g, "");
        line = line.replace(/[,;]\s*[,;]+/g, ";");
        line = line.replace(/\s{2,}/g, " ");
        
        if (line) cleanedLines.push(line);
    }
    return cleanedLines.join("\n") || "Заказ (текст не распознан)";
}

function splitImportText(rawText) {
    const entries = [];
    const hasChatFormat = /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(rawText);

    if (hasChatFormat) {
        const parts = rawText.split(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] [^\n:]+:/);
        for (const msg of parts.slice(1)) {
            if (!msg.trim()) continue;
            const phones = findPhones(msg);
            if (!phones.length) continue;
            const first = phones[0];
            let itemsText = msg.slice(first.index + first.length);
            itemsText = itemsText.split(/(?:✅|📍)/)[0];
            entries.push({ phone: first.phone, itemsText });
        }
    } else {
        const phones = findPhones(rawText);
        for (let i = 0; i < phones.length; i++) {
            const end = i + 1 < phones.length ? phones[i + 1].index : rawText.length;
            let itemsText = rawText.slice(phones[i].index + phones[i].length, end);
            itemsText = itemsText.split(/(?:✅|📍)/)[0];
            entries.push({ phone: phones[i].phone, itemsText });
        }
    }
    return entries;
}

function buildOrderFromImportEntry(entry) {
    let itemsText = entry.itemsText;
    itemsText = itemsText.replace(/^[\s,;.\-+]+/g, "");
    itemsText = itemsText.replace(/\n+/g, "\n").trim();

    const textLower = normalizeText(itemsText);
    const payStatus = detectPaymentStatus(textLower);
    const amount = extractAmount(textLower, payStatus);
    const finalItems = cleanItemsText(itemsText);

    return { items: finalItems, payment_status: payStatus, amount };
}