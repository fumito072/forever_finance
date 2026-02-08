'use server'

import { VertexAI } from "@google-cloud/vertexai";
import { google } from "googleapis";
import { Readable } from "stream";

const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL!;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, '\n');
const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID!;
const GOOGLE_LOCATION = process.env.GOOGLE_LOCATION || 'asia-northeast1';
const ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID!;

// サービスアカウント認証（Drive & Vertex AI 共通）
const credentials = {
  client_email: GOOGLE_CLIENT_EMAIL,
  private_key: GOOGLE_PRIVATE_KEY,
};

// Drive API Auth
const driveAuth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth: driveAuth });

// Vertex AI Auth（サービスアカウントでトークン取得）
const vertexAuth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const vertexAI = new VertexAI({
  project: GOOGLE_PROJECT_ID,
  location: GOOGLE_LOCATION,
  googleAuthOptions: {
    authClient: vertexAuth as never,
  },
});

// 速度優先でFlashモデルを使用
const model = vertexAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { responseMimeType: "application/json" },
});

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
    
    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { data: buffer.toString("base64"), mimeType: file.type } }
        ]
      }]
    });
    
    const responseText = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!responseText) throw new Error("AIからの応答が空です");
    const data = JSON.parse(responseText);
    console.log("AI Result:", data);

    // パス情報の生成
    const dateStr = data.date || new Date().toISOString().split('T')[0];
    const [yyyy, mm] = dateStr.split('-');
    // 和暦短縮形式: 2026年01月 → "2601"
    const yy = yyyy.slice(-2);
    const yearMonthFolder = `${yy}${mm}`;
    const categoryFolder = data.category || "その他";
    const newFileName = `${dateStr}_${categoryFolder}_${data.vendor || '不明'}.jpg`;

    // 2. ドライブフォルダ準備（既存フォルダのみを使用）
    const monthFolderId = await findFolder(yearMonthFolder, ROOT_FOLDER_ID);
    if (!monthFolderId) throw new Error(`月フォルダが見つかりません: ${yearMonthFolder}`);

    const targetFolderId = await resolveCategoryFolder(categoryFolder, monthFolderId);

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
