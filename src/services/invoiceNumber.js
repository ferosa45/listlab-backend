// src/services/invoiceNumber.js
import { prisma } from "../lib/prisma.js"; // 👈 TENTO IMPORT TAM CHYBĚL

export async function generateInvoiceNumber(tx) {
  // Pokud funkce nedostane transakci (tx) z webhooku, použije hlavní prisma klient
  const db = tx || prisma; 
  
  const year = new Date().getFullYear();

  try {
    // Najdeme poslední fakturu v tomto roce
    const last = await db.invoice.findFirst({
      where: { 
        // Hledáme faktury, jejichž číslo začíná letošním rokem (např. "2026-")
        number: { startsWith: `${year}-` }
      },
      orderBy: { createdAt: "desc" }, // Seřadíme od nejnovější
    });

    let nextSequence = 1;

    if (last) {
       // Zkusíme vytáhnout číslo za pomlčkou (např. z "2026-000005" vezmeme "5")
       const parts = last.number.split('-');
       if (parts.length === 2) {
         const seq = parseInt(parts[1]);
         if (!isNaN(seq)) {
           nextSequence = seq + 1;
         }
       }
    }

    // Vrátíme řetězec, např. "2026-000001"
    // (Webhook očekává string, ne objekt)
    return `${year}-${String(nextSequence).padStart(6, "0")}`;

  } catch (err) {
    console.error("Chyba generování čísla faktury:", err);
    // Fallback pro jistotu, aby webhook nespadl
    return `${year}-${Math.floor(100000 + Math.random() * 900000)}`;
  }
}