"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { collection, onSnapshot, orderBy, query, Unsubscribe } from "firebase/firestore";
import { Html5QrcodeScanner } from "html5-qrcode";
import clsx from "clsx";
import Papa from "papaparse";
import { ensureFirestoreClient } from "@/lib/firebaseClient";

type AdjustmentOption = {
  key: string;
  label: string;
  deltaAmount: number;
  requiresReason: boolean;
};

type PricingConfig = {
  generalFee: number;
  bringConsoleFee: number;
  studentFixedFee: number;
  adjustmentOptions: AdjustmentOption[];
};

const defaultPricingConfig: PricingConfig = {
  generalFee: 4000,
  bringConsoleFee: 3000,
  studentFixedFee: 1000,
  adjustmentOptions: [
    { key: "none", label: "変更なし", deltaAmount: 0, requiresReason: false },
    { key: "general_to_bring", label: "一般→持参 (-1000円)", deltaAmount: -1000, requiresReason: false },
    { key: "bring_to_general", label: "持参→一般 (+1000円)", deltaAmount: 1000, requiresReason: false },
    { key: "student_general", label: "学割（一般）(-3000円)", deltaAmount: -3000, requiresReason: false },
    { key: "student_bring", label: "学割（持参）(-2000円)", deltaAmount: -2000, requiresReason: false },
    { key: "other", label: "その他（理由と金額を入力）", deltaAmount: 0, requiresReason: true },
  ],
};

const initialParticipants: Participant[] = [
  {
    participantId: "101",
    playerName: "Skyline",
    adminNotes: "A-01",
    payment: { totalTransaction: 4000, totalOwed: 0, totalPaid: 4000 },
    checkedIn: false,
    editNotes: "",
  },
  {
    participantId: "102",
    playerName: "Luna",
    adminNotes: "B-02",
    payment: { totalTransaction: 0, totalOwed: 4000, totalPaid: 0 },
    checkedIn: false,
    editNotes: "",
  },
  {
    participantId: "103",
    playerName: "Comet",
    adminNotes: "C-03",
    payment: { totalTransaction: 0, totalOwed: 3000, totalPaid: 0 },
    checkedIn: true,
    checkedInAt: new Date().toISOString(),
    editNotes: "2024-06-01 10:15 JST | 事前チェックイン反映",
  },
];

type Payment = {
  totalTransaction: number;
  totalOwed: number;
  totalPaid?: number;
};

type Participant = {
  participantId: string;
  playerName: string;
  adminNotes?: string;
  payment: Payment;
  checkedIn: boolean;
  checkedInAt?: string;
  checkedInBy?: string;
  editNotes?: string;
};

type AuthSession = {
  authenticated: boolean;
  user?: {
    id?: string;
    slug?: string;
    email?: string;
    gamerTag?: string;
  };
};

type PaymentStatus = {
  status: "prepaid" | "due" | "refund";
  amount: number;
  label: string;
};

function parseParticipantIdFromQr(raw: string) {
  const trimmed = raw.trim();
  const urlMatch = trimmed.match(/participant\/(\d+)\/qr/);
  if (urlMatch?.[1]) return urlMatch[1];
  const digitsOnly = trimmed.match(/^\d+$/);
  return digitsOnly ? digitsOnly[0] : null;
}

function computePaymentStatus(
  participant: Participant,
  studentDiscount: boolean,
  adjustment: AdjustmentOption,
  customDelta: number,
  pricing: PricingConfig,
): PaymentStatus {
  const baseDue = participant.payment.totalTransaction !== 0 ? 0 : participant.payment.totalOwed;
  const studentDue = studentDiscount ? pricing.studentFixedFee : baseDue;
  const delta = adjustment.key === "other" ? customDelta : adjustment.deltaAmount;
  const amount = studentDue + delta;
  if (amount > 0) {
    return { status: "due", amount, label: `${amount.toLocaleString()}円 支払` };
  }
  if (amount < 0) {
    return { status: "refund", amount: Math.abs(amount), label: `${Math.abs(amount).toLocaleString()}円 返金` };
  }
  return { status: "prepaid", amount: 0, label: "支払い不要" };
}

function getDisplayName(participant: Participant) {
  return participant.playerName || participant.participantId;
}

function formatTimestampJst(date: Date) {
  const offsetMs = 9 * 60 * 60 * 1000;
  const local = new Date(date.getTime() + offsetMs);
  const yyyy = local.getUTCFullYear();
  const mm = `${local.getUTCMonth() + 1}`.padStart(2, "0");
  const dd = `${local.getUTCDate()}`.padStart(2, "0");
  const hh = `${local.getUTCHours()}`.padStart(2, "0");
  const min = `${local.getUTCMinutes()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} JST`;
}

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<"kiosk" | "operator" | "dashboard">("kiosk");
  const [tournamentId, setTournamentId] = useState("demo-tournament");
  const [pricingConfig, setPricingConfig] = useState<PricingConfig>(defaultPricingConfig);
  const [pricingMessage, setPricingMessage] = useState("");
  const [pricingSource, setPricingSource] = useState<string>("default");
  const [pricingName, setPricingName] = useState("");
  const [pricingSaving, setPricingSaving] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>(initialParticipants);
  const [firestoreReady, setFirestoreReady] = useState(false);
  const [firestoreError, setFirestoreError] = useState("");
  const [scanResult, setScanResult] = useState<Participant | null>(null);
  const [scanRaw, setScanRaw] = useState("");
  const [scannerError, setScannerError] = useState("");
  const [studentDiscount, setStudentDiscount] = useState(false);
  const [selectedAdjustment, setSelectedAdjustment] = useState(defaultPricingConfig.adjustmentOptions[0].key);
  const [customReason, setCustomReason] = useState("");
  const [customAmount, setCustomAmount] = useState(0);
  const [operatorMessage, setOperatorMessage] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [filter, setFilter] = useState<"all" | "checkedIn" | "notCheckedIn">("all");
  const scannerContainerRef = useRef<HTMLDivElement>(null);
  const [authSession, setAuthSession] = useState<AuthSession>({ authenticated: false });
  const [authError, setAuthError] = useState("");

  const adjustmentOption = useMemo(
    () => {
      const options = adjustmentOptions();
      return options.find((opt) => opt.key === selectedAdjustment) ?? options[0];
    },
    [selectedAdjustment, pricingConfig],
  );

  useEffect(() => {
    if (activeTab !== "kiosk") {
      return undefined;
    }
    if (!scannerContainerRef.current) {
      return undefined;
    }
    const elementId = scannerContainerRef.current.id || "qr-reader";
    scannerContainerRef.current.id = elementId;

    const scanner = new Html5QrcodeScanner(elementId, { fps: 10, qrbox: 240 });
    scanner.render(
      (decoded) => {
        setScannerError("");
        setScanRaw(decoded);
        handleLookup(decoded);
      },
      (error) => {
        setScannerError(error);
      },
    );

    return () => {
      scanner.clear().catch(() => {});
    };
  }, [activeTab]);

  useEffect(() => {
    refreshSession();
  }, []);

  useEffect(() => {
    loadPricingConfig(tournamentId);
    // 初期ロードのみ実行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let unsubscribe: Unsubscribe | null = null;
    setFirestoreError("");
    setFirestoreReady(false);

    const connect = async () => {
      try {
        const db = ensureFirestoreClient();
        const q = query(
          collection(db, "tournaments", tournamentId, "participants"),
          orderBy("participantId"),
        );

        unsubscribe = onSnapshot(
          q,
          (snapshot) => {
            const data = snapshot.docs.map((doc) => {
              const d = doc.data() as any;
              const checkedInAt = d.checkedInAt?.toDate ? d.checkedInAt.toDate().toISOString() : d.checkedInAt;
              return {
                participantId: doc.id,
                playerName: d.playerName || doc.id,
                adminNotes: d.adminNotes || "",
                payment: {
                  totalTransaction: d?.payment?.totalTransaction ?? 0,
                  totalOwed: d?.payment?.totalOwed ?? 0,
                  totalPaid: d?.payment?.totalPaid ?? 0,
                },
                checkedIn: Boolean(d.checkedIn),
                checkedInAt: checkedInAt || undefined,
                checkedInBy: d.checkedInBy || undefined,
                editNotes: d.editNotes || "",
              } as Participant;
            });
            setParticipants(data);
            setFirestoreReady(true);
          },
          (error) => {
            setFirestoreError(`リアルタイム取得に失敗しました: ${error.message}`);
          },
        );
      } catch (error: any) {
        setFirestoreError(error?.message || "Firestore クライアント初期化に失敗しました");
      }
    };

    connect();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [tournamentId]);

  useEffect(() => {
    const exists = pricingConfig.adjustmentOptions.some((opt) => opt.key === selectedAdjustment);
    if (!exists && pricingConfig.adjustmentOptions[0]) {
      setSelectedAdjustment(pricingConfig.adjustmentOptions[0].key);
    }
  }, [pricingConfig, selectedAdjustment]);

  function adjustmentOptions(): AdjustmentOption[] {
    return pricingConfig.adjustmentOptions;
  }

  async function loadPricingConfig(targetId: string) {
    setPricingMessage(`料金設定(${targetId})を取得中...`);
    try {
      const res = await fetch(`/api/tournaments/${encodeURIComponent(targetId)}/pricing`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      const config = (data.pricingConfig as PricingConfig) || defaultPricingConfig;
      setPricingConfig(config);
      setPricingSource(data.source || "firestore");
      setPricingName(data.name || "");
      setSelectedAdjustment((config.adjustmentOptions[0]?.key) || "none");
      setPricingMessage(`料金設定を読み込みました（source=${data.source || "firestore"}）`);
    } catch (error: any) {
      setPricingConfig(defaultPricingConfig);
      setPricingSource("default");
      setPricingMessage(`料金設定の取得に失敗しました: ${error?.message || "unknown"}`);
    }
  }

  async function savePricingConfig() {
    setPricingSaving(true);
    setPricingMessage("料金設定を保存しています...");
    try {
      const res = await fetch(`/api/tournaments/${encodeURIComponent(tournamentId)}/pricing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pricingConfig, name: pricingName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setPricingConfig(data.pricingConfig as PricingConfig);
      setPricingSource("firestore");
      setPricingMessage("料金設定をFirestoreに保存しました");
    } catch (error: any) {
      setPricingMessage(`保存に失敗しました: ${error?.message || "unknown"}`);
    } finally {
      setPricingSaving(false);
    }
  }

  function updatePricingField(key: keyof PricingConfig, value: number) {
    setPricingConfig((prev) => ({ ...prev, [key]: value }));
  }

  function updateAdjustment(index: number, key: keyof AdjustmentOption, value: string | number | boolean) {
    setPricingConfig((prev) => {
      const next = [...prev.adjustmentOptions];
      const target = next[index];
      if (!target) return prev;
      next[index] = { ...target, [key]: value } as AdjustmentOption;
      return { ...prev, adjustmentOptions: next };
    });
  }

  function addAdjustment() {
    setPricingConfig((prev) => ({
      ...prev,
      adjustmentOptions: [
        ...prev.adjustmentOptions,
        {
          key: `custom_${prev.adjustmentOptions.length + 1}`,
          label: "新規オプション",
          deltaAmount: 0,
          requiresReason: false,
        },
      ],
    }));
  }

  function removeAdjustment(index: number) {
    setPricingConfig((prev) => {
      if (prev.adjustmentOptions.length <= 1) return prev;
      const next = prev.adjustmentOptions.filter((_, i) => i !== index);
      return { ...prev, adjustmentOptions: next };
    });
  }

  async function refreshSession() {
    try {
      const res = await fetch("/api/auth/session");
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as AuthSession;
      setAuthSession(data);
      setAuthError("");
    } catch (error: any) {
      setAuthError("認証状態の取得に失敗しました: " + (error?.message ?? ""));
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthSession({ authenticated: false });
  }

  function handleLookup(raw: string) {
    const participantId = parseParticipantIdFromQr(raw);
    if (!participantId) {
      setScanResult(null);
      setScannerError("QRからparticipantIdを取得できませんでした");
      return;
    }
    const participant = participants.find((p) => p.participantId === participantId) || null;
    setScanResult(participant);
    setScannerError(participant ? "" : "対象の参加者が見つかりません");
  }

  function handleManualLookup() {
    handleLookup(scanRaw.trim());
  }

  async function handleCheckIn() {
    if (!scanResult) return;
    if (scanResult.checkedIn) return;

    const delta = adjustmentOption.key === "other" ? customAmount : adjustmentOption.deltaAmount;
    const reasonLabel = adjustmentOption.key === "other" ? `その他: ${customReason}` : adjustmentOption.label;

    try {
      const res = await fetch(
        `/api/tournaments/${encodeURIComponent(tournamentId)}/participants/${encodeURIComponent(scanResult.participantId)}/checkin`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deltaAmount: delta,
            reasonLabel,
            operatorUserId: authSession.user?.id || "operator-demo",
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setOperatorMessage(`${getDisplayName(scanResult)} をチェックインしました`);
    } catch (error: any) {
      setOperatorMessage(`チェックインに失敗しました: ${error?.message || "unknown"}`);
    }
  }

  function handleCsvUpload(file: File) {
    setOperatorMessage("CSVを解析しています...");
    Papa.parse(file, {
      skipEmptyLines: "greedy",
      complete: (results) => {
        const rows = results.data as string[][];
        const headerIndex = rows.findIndex((row) => {
          const cells = row.map((cell) => String(cell).trim());
          return cells.includes("Id") && (cells.includes("GamerTag") || cells.includes("Short GamerTag"));
        });

        if (headerIndex === -1) {
          setOperatorMessage("ヘッダー行を特定できませんでした");
          return;
        }

        const headers = rows[headerIndex].map((cell) => String(cell).trim());
        const dataRows = rows.slice(headerIndex + 1).filter((row) => row.some((cell) => String(cell).trim() !== ""));

        const whitelist = [
          "Id",
          "GamerTag",
          "Short GamerTag",
          "Admin Notes",
          "Checked In",
          "Total Owed",
          "Total Paid",
          "Total Transaction",
        ];

        const indexMap: Record<string, number> = {};
        whitelist.forEach((key) => {
          indexMap[key] = headers.indexOf(key);
        });

        const importedParticipants: Participant[] = dataRows.map((row) => {
          const id = indexMap["Id"] >= 0 ? String(row[indexMap["Id"]]).trim() : "";
          const gamerTag = indexMap["GamerTag"] >= 0 ? String(row[indexMap["GamerTag"]]).trim() : "";
          const shortTag = indexMap["Short GamerTag"] >= 0 ? String(row[indexMap["Short GamerTag"]]).trim() : "";
          const adminNotes = indexMap["Admin Notes"] >= 0 ? String(row[indexMap["Admin Notes"]]).trim() : "";
          const totalOwed = Number(row[indexMap["Total Owed"]] || 0);
          const totalPaid = Number(row[indexMap["Total Paid"]] || 0);
          const totalTransaction = Number(row[indexMap["Total Transaction"]] || 0);
          const checkedInRaw = indexMap["Checked In"] >= 0 ? String(row[indexMap["Checked In"]]).trim().toLowerCase() : "false";
          const checkedIn = ["true", "yes", "1"].includes(checkedInRaw);

          return {
            participantId: id,
            playerName: gamerTag || shortTag || id,
            adminNotes,
            payment: {
              totalTransaction,
              totalOwed,
              totalPaid,
            },
            checkedIn,
            editNotes: "",
          };
        }).filter((p) => p.participantId);

        if (!importedParticipants.length) {
          setOperatorMessage("取り込めるデータがありません");
          return;
        }

        fetch(`/api/tournaments/${encodeURIComponent(tournamentId)}/participants`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participants: importedParticipants }),
        })
          .then(async (res) => {
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || res.statusText);
            setOperatorMessage(`CSVをFirestoreに保存しました（${data.count}件）`);
          })
          .catch((err) => setOperatorMessage(`CSV保存に失敗しました: ${err.message}`));
      },
      error: () => setOperatorMessage("CSVの解析に失敗しました"),
    });
  }

  const filteredParticipants = useMemo(() => {
    return participants.filter((p) => {
      const matchesSearch = getDisplayName(p).toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.participantId.includes(searchTerm);
      const matchesFilter =
        filter === "all" ||
        (filter === "checkedIn" && p.checkedIn) ||
        (filter === "notCheckedIn" && !p.checkedIn);
      return matchesSearch && matchesFilter;
    });
  }, [participants, searchTerm, filter]);

  const paymentStatus = scanResult
    ? computePaymentStatus(scanResult, studentDiscount, adjustmentOption, customAmount, pricingConfig)
    : null;

  const disableSubmit = !scanResult || scanResult.checkedIn ||
    (adjustmentOption.requiresReason && (!customReason.trim() || customAmount === 0));

  return (
    <div className="container">
      <header>
        <div className="brand">
          <div className="logo">GG</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 22 }}>start.gg チェックイン</div>
            <div className="muted">QRスキャン / CSVアップロード / ダッシュボード</div>
          </div>
        </div>
        <div className="tablist" role="tablist">
          {[
            { key: "kiosk", label: "受付スキャン" },
            { key: "operator", label: "運営アップロード" },
            { key: "dashboard", label: "ダッシュボード" },
          ].map((tab) => (
            <button
              key={tab.key}
              className={clsx("tab", { active: activeTab === tab.key })}
              onClick={() => setActiveTab(tab.key as typeof activeTab)}
              role="tab"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      {activeTab === "kiosk" && (
        <div className="card-grid">
          <div className="card">
            <div className="section-title">QRスキャン</div>
            <div ref={scannerContainerRef} style={{ borderRadius: 12, overflow: "hidden" }} />
            <div className="divider" />
            <label className="label" htmlFor="manual-qr">手動入力（QR文字列）</label>
            <input
              id="manual-qr"
              className="input"
              value={scanRaw}
              onChange={(e) => setScanRaw(e.target.value)}
              placeholder="http://www.start.gg/api/-/gg_api./participant/102/qr?token=..."
            />
            <div className="flex" style={{ marginTop: 8 }}>
              <button className="button" onClick={handleManualLookup}>参加者を照合</button>
              {scannerError && <span className="muted">{scannerError}</span>}
            </div>
          </div>

          <div className="card">
            <div className="section-title">参加者情報</div>
            {scanResult ? (
              <div className="stack">
                <div className="flex-between">
                  <div style={{ fontSize: 20, fontWeight: 800 }}>{getDisplayName(scanResult)}</div>
                  {scanResult.checkedIn ? (
                    <span className="status success">チェックイン済み</span>
                  ) : (
                    <span className={clsx("status", paymentStatus?.status === "prepaid" ? "success" : "danger")}>{paymentStatus?.label}</span>
                  )}
                </div>
                <div className="tag-grid">
                  <span className="badge">ID: {scanResult.participantId}</span>
                  <span className="badge">対戦台: {scanResult.adminNotes || "未割当"}</span>
                  <span className="badge">Total Transaction: {scanResult.payment.totalTransaction}</span>
                  <span className="badge">Total Owed: {scanResult.payment.totalOwed}</span>
                </div>

                <div className="divider" />

                <label className="label">学割</label>
                <div className="flex">
                  <input
                    id="student"
                    type="checkbox"
                    checked={studentDiscount}
                    onChange={(e) => setStudentDiscount(e.target.checked)}
                  />
                  <label htmlFor="student" className="muted">学割を適用（当日支払 1,000円）</label>
                </div>

                <label className="label" htmlFor="adjustment">枠変更・差額</label>
                <select
                  id="adjustment"
                  className="select"
                  value={selectedAdjustment}
                  onChange={(e) => setSelectedAdjustment(e.target.value)}
                >
                  {adjustmentOptions().map((opt) => (
                    <option key={opt.key} value={opt.key}>{opt.label}</option>
                  ))}
                </select>

                {adjustmentOption.requiresReason && (
                  <div className="stack">
                    <label className="label" htmlFor="custom-reason">理由</label>
                    <input
                      id="custom-reason"
                      className="input"
                      value={customReason}
                      onChange={(e) => setCustomReason(e.target.value)}
                      placeholder="枠変更理由を入力"
                    />
                    <label className="label" htmlFor="custom-amount">増減金額（例: -1000 or 500）</label>
                    <input
                      id="custom-amount"
                      className="input"
                      type="number"
                      value={customAmount}
                      onChange={(e) => setCustomAmount(Number(e.target.value))}
                    />
                  </div>
                )}

                <div className="flex-between" style={{ marginTop: 6 }}>
                  <div className="muted">背景色ルール：支払い不要=緑 / 支払い・返金=赤</div>
                  {paymentStatus && (
                    <span className={clsx("status", paymentStatus.status === "prepaid" ? "success" : "danger")}>{paymentStatus.label}</span>
                  )}
                </div>

                <button className="button" disabled={disableSubmit} onClick={handleCheckIn}>
                  チェックイン確定
                </button>
                {scanResult.checkedIn && <div className="muted">再チェックインは無効化されています</div>}
              </div>
            ) : (
              <div className="muted">QRを読み取ると参加者情報が表示されます</div>
            )}
          </div>
        </div>
      )}

      {activeTab === "operator" && (
        <div className="card-grid">
          <div className="card">
            <div className="section-title">Firestore リアルタイム同期</div>
            {firestoreReady ? (
              <div className="toast success">参加者データをリアルタイム購読中（{tournamentId}）</div>
            ) : (
              <div className="toast">Firestore クライアント設定を確認してください</div>
            )}
            {firestoreError && <div className="toast danger">{firestoreError}</div>}
            <p className="muted">NEXT_PUBLIC_FIREBASE_* でクライアント設定し、Firestore セキュリティルールで適切に保護してください。</p>
          </div>

          <div className="card">
            <div className="section-title">大会ごとの料金設定（Firestore 保存）</div>
            <p className="muted">トーナメントID単位で pricingConfig を保存・取得します。Firestore に保存した設定がチェックイン計算に反映されます。</p>
            <div className="stack">
              <label className="label" htmlFor="tournament-id">トーナメントID (例: evo-japan-2025)</label>
              <input
                id="tournament-id"
                className="input"
                value={tournamentId}
                onChange={(e) => setTournamentId(e.target.value)}
                placeholder="tournament-identifier"
              />
              <label className="label" htmlFor="tournament-name">大会名（任意でFirestoreに保存）</label>
              <input
                id="tournament-name"
                className="input"
                value={pricingName}
                onChange={(e) => setPricingName(e.target.value)}
                placeholder="大会名"
              />
              <div className="flex" style={{ gap: 8, flexWrap: "wrap" }}>
                <button className="button" type="button" onClick={() => loadPricingConfig(tournamentId)}>
                  Firestoreから取得
                </button>
                <button className="button" type="button" onClick={savePricingConfig} disabled={pricingSaving}>
                  {pricingSaving ? "保存中..." : "Firestoreへ保存"}
                </button>
                <span className="muted">取得元: {pricingSource}</span>
              </div>
              {pricingMessage && <div className="toast">{pricingMessage}</div>}
            </div>

            <div className="divider" />
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <div className="stack">
                <label className="label" htmlFor="general-fee">一般料金</label>
                <input
                  id="general-fee"
                  className="input"
                  type="number"
                  value={pricingConfig.generalFee}
                  onChange={(e) => updatePricingField("generalFee", Number(e.target.value))}
                />
              </div>
              <div className="stack">
                <label className="label" htmlFor="bring-fee">持参料金</label>
                <input
                  id="bring-fee"
                  className="input"
                  type="number"
                  value={pricingConfig.bringConsoleFee}
                  onChange={(e) => updatePricingField("bringConsoleFee", Number(e.target.value))}
                />
              </div>
              <div className="stack">
                <label className="label" htmlFor="student-fee">学割 (固定)</label>
                <input
                  id="student-fee"
                  className="input"
                  type="number"
                  value={pricingConfig.studentFixedFee}
                  onChange={(e) => updatePricingField("studentFixedFee", Number(e.target.value))}
                />
              </div>
            </div>

            <div className="divider" />
            <div className="section-title">差額オプション</div>
            <div className="stack" style={{ gap: 12 }}>
              {pricingConfig.adjustmentOptions.map((opt, index) => (
                <div key={opt.key || index} className="card" style={{ background: "#0d1117" }}>
                  <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                    <div className="stack">
                      <label className="label">キー</label>
                      <input
                        className="input"
                        value={opt.key}
                        onChange={(e) => updateAdjustment(index, "key", e.target.value)}
                      />
                    </div>
                    <div className="stack">
                      <label className="label">ラベル</label>
                      <input
                        className="input"
                        value={opt.label}
                        onChange={(e) => updateAdjustment(index, "label", e.target.value)}
                      />
                    </div>
                    <div className="stack">
                      <label className="label">増減金額</label>
                      <input
                        className="input"
                        type="number"
                        value={opt.deltaAmount}
                        onChange={(e) => updateAdjustment(index, "deltaAmount", Number(e.target.value))}
                      />
                    </div>
                    <div className="stack">
                      <label className="label">理由必須</label>
                      <div className="flex" style={{ gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={opt.requiresReason}
                          onChange={(e) => updateAdjustment(index, "requiresReason", e.target.checked)}
                        />
                        <span className="muted">その他など理由入力必須にする</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex-between" style={{ marginTop: 6 }}>
                    <span className="muted">表示例: {opt.label} / {opt.deltaAmount}円</span>
                    {pricingConfig.adjustmentOptions.length > 1 && (
                      <button className="button secondary" type="button" onClick={() => removeAdjustment(index)}>
                        削除
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <button className="button" type="button" onClick={addAdjustment}>オプションを追加</button>
            </div>
          </div>

          <div className="card">
            <div className="section-title">start.gg OAuth2 ログイン</div>
            <p className="muted">Authorization Code Flow で start.gg にリダイレクトし、アクセストークンをサーバーで交換・保存します。</p>
            <div className="stack">
              <a className="button" href="/api/auth/login">start.gg でログイン</a>
              <div className="muted">リダイレクト後、GraphQL API で currentUser を取得し cookie に保存します。</div>
              {authSession.authenticated ? (
                <div className="toast success">
                  <div>ログイン済み: {authSession.user?.gamerTag || authSession.user?.email || authSession.user?.id}</div>
                  <div className="flex" style={{ gap: 8 }}>
                    <button className="button" onClick={refreshSession}>状態を再取得</button>
                    <button className="button secondary" onClick={logout}>ログアウト</button>
                  </div>
                </div>
              ) : (
                <div className="toast">未ログイン。上のボタンから start.gg へ遷移してください。</div>
              )}
              {authError && <div className="toast danger">{authError}</div>}
            </div>
          </div>

          <div className="card">
            <div className="section-title">参加者CSVアップロード</div>
            <p className="muted">ヘッダー検出後、ホワイトリスト列のみ取り込み（Id/GamerTag/Short GamerTag/Admin Notes/Checked In/Total Owed/Total Paid/Total Transaction）。</p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleCsvUpload(file);
              }}
              className="input"
            />
            {operatorMessage && <div className="toast" style={{ marginTop: 8 }}>{operatorMessage}</div>}
            <div className="divider" />
            <div className="muted">個人情報列はクライアント側で破棄されます。既存 participantId があれば checkedIn=true は維持したまま上書きします。</div>
          </div>
        </div>
      )}

      {activeTab === "dashboard" && (
        <div className="card">
          <div className="section-title">チェックイン状況</div>
          <div className="flex" style={{ marginBottom: 12 }}>
            <input
              className="input"
              placeholder="ID または プレイヤー名で検索"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <select className="select" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">すべて</option>
              <option value="checkedIn">チェックイン済み</option>
              <option value="notCheckedIn">未チェックイン</option>
            </select>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>プレイヤー名</th>
                <th>台番号 (Admin Notes)</th>
                <th>支払い</th>
                <th>チェックイン</th>
                <th>editNotes</th>
              </tr>
            </thead>
            <tbody>
              {filteredParticipants.map((p) => {
                const status = computePaymentStatus(
                  p,
                  false,
                  { key: "none", label: "変更なし", deltaAmount: 0, requiresReason: false },
                  0,
                  pricingConfig,
                );
                return (
                  <tr key={p.participantId}>
                    <td>{p.participantId}</td>
                    <td>{getDisplayName(p)}</td>
                    <td>{p.adminNotes || "-"}</td>
                    <td>
                      <span className={clsx("status", status.status === "prepaid" ? "success" : "danger")}>{status.label}</span>
                    </td>
                    <td>{p.checkedIn ? formatTimestampJst(new Date(p.checkedInAt || "")) : "未"}</td>
                    <td>{p.editNotes || ""}</td>
                  </tr>
                );
              })}
              {filteredParticipants.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">該当データがありません</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
