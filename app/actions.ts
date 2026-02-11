'use server'

import { google } from "googleapis";
import { Readable } from "stream";

const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL!;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, '\n');
const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID!;
const GOOGLE_LOCATION = process.env.GOOGLE_LOCATION || 'asia-northeast1';
const ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID!;

// サービスアカウント認証（Drive & Vertex AI 共通）
const jwtClient = new google.auth.JWT({
  email: GOOGLE_CLIENT_EMAIL,
  key: GOOGLE_PRIVATE_KEY,
  scopes: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/cloud-platform',
  ],
});

// Drive API
const drive = google.drive({ version: 'v3', auth: jwtClient });

// Vertex AI Gemini を REST API で呼び出す（リトライ付き）
async function callGemini(prompt: string, imageBase64: string, mimeType: string) {
  const accessToken = (await jwtClient.getAccessToken()).token;
  const fallbackLocation = process.env.GOOGLE_LOCATION_FALLBACK;
  const locations = [GOOGLE_LOCATION, fallbackLocation, 'us-central1']
    .filter((v): v is string => Boolean(v))
    .filter((v, i, arr) => arr.indexOf(v) === i);
  
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inlineData: { data: imageBase64, mimeType } }
      ]
    }],
    generationConfig: { responseMimeType: "application/json" },
  };

  // リトライ: 429の場合のみ短い待機＋リージョン切替（Vercelの実行時間上限を超えないように）
  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let last429Text: string | null = null;

    for (const location of locations) {
      const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${GOOGLE_PROJECT_ID}/locations/${location}/publishers/google/models/gemini-2.5-flash:generateContent`;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        last429Text = await res.text();
        continue;
      }

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Vertex AI error (${res.status}): ${err}`);
      }

      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('AIからの応答が空です');
      return JSON.parse(text);
    }

    // どのリージョンでも429だった場合のみ待機して再試行
    if (attempt < maxAttempts - 1) {
      const waitMs = 800 * (attempt + 1);
      console.log(`Rate limited, retrying in ${waitMs}ms... (attempt ${attempt + 1}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    throw new Error(`Vertex AI error (429): ${last429Text ?? 'Resource exhausted'}`);
  }

  throw new Error("リトライ上限に達しました");
}

export async function processReceipt(formData: FormData) {
  const file = formData.get("file") as File;
  if (!file || file.size === 0) return { success: false, message: "ファイルが空です" };

  try {
    console.log(`Processing: ${file.name}`);
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 1. Vertex AI Geminiで解析
    const prompt = `この領収書画像を解析し、JSONを返して。
      keys:
      - date: YYYY-MM-DD (不明なら今日)
      - amount: 数値
      - vendor: 店名 (短く)
      - category: [会議費, 交通費, 接待交際費, 消耗品費, 通信費, その他] から最適なのを選択`;
    
    const data = await callGemini(prompt, buffer.toString("base64"), file.type);
    console.log("AI Result:", data);

    // パス情報の生成
    const dateStr = data.date || new Date().toISOString().split('T')[0];
    const [yyyy, mm] = dateStr.split('-');
    const year = parseInt(yyyy, 10);
    const categoryFolder = data.category || "その他";
    const newFileName = `${dateStr}_${categoryFolder}_${data.vendor || '不明'}.jpg`;

    // 2. ドライブフォルダ準備（既存フォルダのみを使用）
    let parentFolderId: string;
    if (year <= 2025) {
      // 2025年以前 → "25年までの経費" フォルダに直接格納
      const oldFolder = await findFolder('25年までの経費', ROOT_FOLDER_ID);
      if (!oldFolder) throw new Error('「25年までの経費」フォルダが見つかりません');
      parentFolderId = oldFolder;
    } else {
      // 2026年以降 → YYMM形式のフォルダ（例: 2601）
      const yy = yyyy.slice(-2);
      const yearMonthFolder = `${yy}${mm}`;
      const monthFolderId = await findFolder(yearMonthFolder, ROOT_FOLDER_ID);
      if (!monthFolderId) throw new Error(`月フォルダが見つかりません: ${yearMonthFolder}`);
      parentFolderId = monthFolderId;
    }

    const targetFolderId = await resolveCategoryFolder(categoryFolder, parentFolderId);

    // 3. アップロード
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    await drive.files.create({
      requestBody: { name: newFileName, parents: [targetFolderId] },
      media: { mimeType: file.type, body: stream },
      supportsAllDrives: true
    });
    console.log(`Saved: ${newFileName}`);

    return { success: true, message: `「${newFileName}」を保存しました！`, data };

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "エラーが発生しました";
    console.error("Error:", errorMessage);
    return { success: false, message: errorMessage };
  }
}

// 既存フォルダ検索ヘルパー
async function findFolder(name: string, parentId: string) {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and '${parentId}' in parents and trashed=false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives'
  });
  return res.data.files?.[0]?.id ?? null;
}

async function listChildFolders(parentId: string) {
  const q = `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives'
  });
  return res.data.files ?? [];
}

const CATEGORY_FALLBACKS: Record<string, string[]> = {
  会議費: ['会議費', '3-領収書', 'その他', '7-その他'],
  交通費: ['交通費', '3-領収書', 'その他', '7-その他'],
  接待交際費: ['接待交際費', '3-領収書', 'その他', '7-その他'],
  消耗品費: ['消耗品費', '3-領収書', 'その他', '7-その他'],
  通信費: ['通信費', '3-領収書', 'その他', '7-その他'],
  その他: ['その他', '7-その他', '3-領収書'],
};

async function resolveCategoryFolder(category: string, parentId: string) {
  const folders = await listChildFolders(parentId);
  const folderMap = new Map(folders.map((f) => [f.name!, f.id!]));

  const candidates = CATEGORY_FALLBACKS[category] ?? [category, '3-領収書', 'その他', '7-その他'];
  for (const name of candidates) {
    const id = folderMap.get(name);
    if (id) return id;
  }

  const available = folders.map((f) => f.name).filter(Boolean).join(', ');
  throw new Error(`カテゴリフォルダが見つかりません: ${category}. 利用可能: ${available}`);
}
