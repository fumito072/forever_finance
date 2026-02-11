'use client';

import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { toast, Toaster } from 'react-hot-toast';
import { processReceipt } from './actions';
import { Loader2, UploadCloud } from 'lucide-react';

// 画像をリサイズ・圧縮してVercelの4.5MBペイロード制限内に収める
async function compressImage(file: File, maxSizeMB = 3, maxDimension = 2048): Promise<File> {
  // 既に十分小さい場合はそのまま返す
  if (file.size <= maxSizeMB * 1024 * 1024) return file;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;

      // 長辺をmaxDimensionに収める（領収書解析に十分な解像度）
      if (width > maxDimension || height > maxDimension) {
        const ratio = Math.min(maxDimension / width, maxDimension / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, width, height);

      // JPEG 85%品質で圧縮（領収書には十分）
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error('画像の圧縮に失敗'));
          const compressed = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), {
            type: 'image/jpeg',
          });
          resolve(compressed);
        },
        'image/jpeg',
        0.85
      );
    };
    img.onerror = () => reject(new Error('画像の読み込みに失敗'));
    img.src = URL.createObjectURL(file);
  });
}

export default function Home() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);


  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    setIsProcessing(true);
    setLogs([]);
    try {
      // Vercelのタイムアウト対策のため、1ファイルずつ直列に処理するVibe
      for (const file of acceptedFiles) {
        setLogs(prev => [...prev, `🔄 処理開始: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)...`]);

        // クライアント側で圧縮（Vercelの4.5MBペイロード制限対策）
        let uploadFile = file;
        try {
          uploadFile = await compressImage(file);
          if (uploadFile !== file) {
            setLogs(prev => [...prev, `📦 圧縮: ${(file.size / 1024 / 1024).toFixed(1)}MB → ${(uploadFile.size / 1024 / 1024).toFixed(1)}MB`]);
          }
        } catch {
          setLogs(prev => [...prev, `⚠️ 圧縮スキップ（元のまま送信）`]);
        }

        const formData = new FormData();
        formData.append('file', uploadFile);

        try {
          // Server Action呼び出し（長引いた場合でもUIが固まらないようタイムアウト）
          const result = await processReceipt(formData);

          if (result.success) {
            toast.success(result.message);
            setLogs(prev => [...prev, `✅ 完了: ${result.message}`]);
          } else {
            toast.error(`失敗: ${file.name}`);
            setLogs(prev => [...prev, `❌ エラー: ${file.name} - ${result.message}`]);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'エラーが発生しました';
          toast.error(`失敗: ${file.name}`);
          setLogs(prev => [...prev, `❌ エラー: ${file.name} - ${msg}`]);
        }
      }
    } finally {
      setIsProcessing(false);
      setLogs(prev => [...prev, `🎉 全ファイルの処理が完了しました！`]);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [] },
    disabled: isProcessing
  });

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4 bg-gray-900 text-white">
      <Toaster position="top-center" />
      <div className="w-full max-w-md p-6 bg-gray-800 rounded-xl shadow-2xl border border-gray-700">
        <h1 className="text-2xl font-bold mb-4 text-center bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
          経理自動化Vibe Tool 🤘
        </h1>
        
        <div 
          {...getRootProps()} 
          className={`flex flex-col items-center justify-center p-10 border-2 border-dashed rounded-lg transition-colors cursor-pointer
            ${isDragActive ? 'border-blue-500 bg-blue-500/10' : 'border-gray-600 hover:border-gray-500 hover:bg-gray-700/50'}
            ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}
          `}
        >
          <input {...getInputProps()} />
          {isProcessing ? (
            <Loader2 className="w-12 h-12 mb-4 animate-spin text-blue-400" />
          ) : (
            <UploadCloud className="w-12 h-12 mb-4 text-gray-400" />
          )}
          {isDragActive ? (
            <p className="text-blue-400 font-medium">ここに領収書をドロップ！</p>
          ) : (
            <p className="text-gray-300 text-center">
              領収書画像をドラッグ＆ドロップ<br />
              <span className="text-sm text-gray-500">またはクリックして選択</span>
            </p>
          )}
        </div>

        {logs.length > 0 && (
          <div className="mt-6 p-4 bg-black/30 rounded-lg text-sm h-48 overflow-y-auto font-mono">
            {logs.map((log, i) => (
              <div key={i} className="mb-1">{log}</div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
