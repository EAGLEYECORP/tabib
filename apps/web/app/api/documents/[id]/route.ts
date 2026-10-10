import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "../../../../lib/supabase/server";
import { DOCUMENTS_BUCKET } from "../../../../lib/documents/kinds";

/**
 * Downloading a document.
 *
 * Nothing is proxied through this server. The row is fetched with the
 * caller's own session, so row-level security decides whether they may see it
 * at all; only then is a short-lived signed URL minted and the browser sent
 * there. The bucket is private, so that URL is the only way to the bytes and
 * it stops working within the minute.
 *
 * A caller who may not have the document gets 404 rather than 403, so the
 * endpoint never confirms that a given id exists.
 */

export const runtime = "nodejs";

/** Long enough to start a download on a slow connection, short enough that a
 *  leaked URL is worthless. */
const SIGNED_URL_TTL_SECONDS = 60;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Not found", { status: 404 });

  const { id } = await context.params;

  const { data: document } = await supabase
    .from("documents")
    .select("storage_path, filename")
    .eq("id", id)
    .maybeSingle();

  if (!document) return new NextResponse("Not found", { status: 404 });

  // `download` makes Storage serve the object as an attachment under the
  // original name, so a PDF or an image is saved rather than rendered in this
  // origin.
  const { data: signed, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(document.storage_path, SIGNED_URL_TTL_SECONDS, {
      download: document.filename,
    });

  if (error || !signed?.signedUrl) {
    // The row survived but the object did not, or Storage refused: a
    // server-side fault, not a missing document.
    return new NextResponse("Document unavailable", { status: 500 });
  }

  return NextResponse.redirect(signed.signedUrl, {
    status: 307,
    headers: {
      // A medical record must not sit in a shared cache, and the signed URL
      // must not leak through a referrer header.
      "Cache-Control": "private, no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/**
 * Deleting a document.
 *
 * Goes through soft_delete_document, which checks ownership, marks the row and
 * hands back the object key. The bytes are then removed, because "delete" has
 * to mean the file is gone rather than hidden; the row itself survives so a
 * doctor's record of what informed a consultation is not rewritten.
 */
export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "NOT_AUTHENTICATED" }, { status: 401 });

  const { id } = await context.params;

  const { data: storagePath, error } = await supabase.rpc("soft_delete_document", {
    doc_id: id,
  });

  if (error) {
    return NextResponse.json({ error: "NOT_FOUND_OR_FORBIDDEN" }, { status: 404 });
  }

  if (typeof storagePath === "string" && storagePath.length > 0) {
    await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath]);
  }

  return NextResponse.json({ deleted: true });
}
