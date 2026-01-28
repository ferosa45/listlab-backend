import { prisma } from "../lib/prisma.js"; // 👈 DŮLEŽITÉ: Přidán import

export async function generateInvoiceNumber(tx) {
  // Pokud nedostaneme transakci (tx), použijeme hlavní prisma klient
  const db = tx || prisma;
  
  const year = new Date().getFullYear();

  try {
    // Pokusíme se najít poslední fakturu podle roku a sekvence
    // (Předpokládá, že máš v DB sloupce 'year' a 'sequence')
    const last = await db.invoice.findFirst({
      where: { year },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });

    const nextSequence = (last?.sequence ?? 0) + 1;
    
    // Vygenerujeme formát čísla, např. 2026-000001
    const number = `${year}-${String(nextSequence).padStart(6, "0")}`;

    // Vracíme POUZE číslo (string), protože webhook to tak čeká
    return number;

  } catch (err) {
    // Pokud tvá databáze nemá sloupce 'year' a 'sequence', spadlo by to.
    // Zde je bezpečný fallback, který funguje vždy (najde poslední číslo jako string)
    console.warn("⚠️ Standardní generování selhalo (asi chybí sloupce year/sequence), používám fallback.", err.message);
    
    const lastSimple = await db.invoice.findFirst({
        where: { number: { startsWith: `${year}` } },
        orderBy: { createdAt: 'desc' }
    });

    if (!lastSimple) return `${year}-000001`;
    
    // Zkusíme vytáhnout číslo z konce stringu
    const match = lastSimple.number.match(/(\d+)$/);
    if (match) {
        const next = parseInt(match[1]) + 1;
        return `${year}-${String(next).padStart(6, "0")}`;
    }
    
    return `${year}-${Math.floor(100000 + Math.random() * 900000)}`;
  }
}