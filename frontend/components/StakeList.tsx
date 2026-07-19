"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { monadTestnet } from "@/lib/wagmi";
import { BACKEND_URL, SHIPSTAKE_ABI, SHIPSTAKE_ADDRESS, explorerTxUrl } from "@/lib/contract";
import { friendlyWalletError } from "@/lib/errors";

type Stake = {
  id: number;
  stakeId: number;
  ownerAddress: string;
  amountWei: string;
  repo: string;
  prNumber: number;
  deadline: string;
  resolved: boolean;
  shipped: boolean | null;
  resolvedTxHash: string | null;
  createdAt: string;
};

function statusBadge(stake: Stake) {
  if (!stake.resolved) return { label: "Pending", color: "bg-lavender/20 text-lavender" };
  if (stake.shipped) return { label: "Shipped", color: "bg-moss/20 text-moss" };
  return { label: "Forfeited", color: "bg-rust/20 text-rust" };
}

const AUTO_CHECK_INTERVAL_MS = 20000;

export function StakeList({ refreshKey }: { refreshKey: number }) {
  const [mounted, setMounted] = useState(false);
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: monadTestnet.id });
  const { data: walletClient } = useWalletClient({ chainId: monadTestnet.id });
  const [stakes, setStakes] = useState<Stake[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [autoChecking, setAutoChecking] = useState(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(`${BACKEND_URL}/stakes?ownerAddress=${address}`);
      if (res.ok) setStakes(await res.json());
    } catch {
      // backend not reachable yet — silently retry on next refresh
    }
  }, [address]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const wrongNetwork = chainId !== undefined && chainId !== monadTestnet.id;

  useEffect(() => {
    if (!address) return;

    const runAutoCheck = async () => {
      if (inFlightRef.current) return;
      const pending = stakes.filter((s) => !s.resolved);
      if (pending.length === 0) return;

      inFlightRef.current = true;
      setAutoChecking(true);
      try {
        await Promise.all(
          pending.map((s) =>
            fetch(`${BACKEND_URL}/stakes/${s.stakeId}/check`, { method: "POST" }).catch(() => null),
          ),
        );
        await load();
      } finally {
        inFlightRef.current = false;
        setAutoChecking(false);
      }
    };

    const interval = setInterval(runAutoCheck, AUTO_CHECK_INTERVAL_MS);
    runAutoCheck();

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, stakes.length]);

  async function handleCheck(stakeId: number) {
    setActionError(null);
    setBusyId(stakeId);
    try {
      await fetch(`${BACKEND_URL}/stakes/${stakeId}/check`, { method: "POST" });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function handleClaimExpired(stakeId: number) {
    setActionError(null);
    if (wrongNetwork) {
      setActionError("Switch your wallet to Monad Testnet first (button in the top right).");
      return;
    }
    if (!walletClient || !publicClient || !address) {
      setActionError("Wallet not ready yet — try again in a moment.");
      return;
    }
    setBusyId(stakeId);
    try {
      const gasEstimate = await publicClient.estimateContractGas({
        address: SHIPSTAKE_ADDRESS,
        abi: SHIPSTAKE_ABI,
        functionName: "claimExpired",
        args: [BigInt(stakeId)],
        account: address,
      });
      const gasLimit = gasEstimate + gasEstimate / 10n;

      const hash = await walletClient.writeContract({
        address: SHIPSTAKE_ADDRESS,
        abi: SHIPSTAKE_ABI,
        functionName: "claimExpired",
        args: [BigInt(stakeId)],
        gas: gasLimit,
        chain: monadTestnet,
        account: address,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await load();
    } catch (err) {
      setActionError(friendlyWalletError(err));
    } finally {
      setBusyId(null);
    }
  }

  if (!mounted || !address) {
    return (
      <div className="glass-panel flex items-center justify-center rounded-3xl p-6 text-sm text-muted">
        Connect your wallet to see your stakes.
      </div>
    );
  }

  return (
    <div className="glass-panel rounded-3xl p-6">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold">Your Stakes</h2>
        {autoChecking && <span className="text-xs text-muted">checking GitHub…</span>}
      </div>

      {actionError && (
        <div className="mb-4 rounded-xl bg-rust/15 p-3 text-sm text-rust">{actionError}</div>
      )}

      {stakes.length === 0 ? (
        <div className="text-sm text-muted">No stakes yet — create one on the left.</div>
      ) : (
        <ul className="space-y-3">
          {stakes.map((stake) => {
            const badge = statusBadge(stake);
            const isPastDeadline = new Date(stake.deadline).getTime() < Date.now();
            const amountMon = (Number(stake.amountWei) / 1e18).toFixed(3);
            return (
              <li key={stake.stakeId} className="glass-row rounded-2xl p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium">{stake.repo}</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.color}`}>
                    {badge.label}
                  </span>
                </div>
                <div className="mb-3 text-sm text-muted">
                  PR #{stake.prNumber} · {amountMon} MON · due{" "}
                  {new Date(stake.deadline).toLocaleDateString()}
                </div>
                {stake.resolved && (
                  <div className="mb-3 text-sm">
                    {stake.shipped ? (
                      <span className="text-moss">
                        ✓ {amountMon} MON returned to your wallet automatically — nothing to withdraw.
                      </span>
                    ) : (
                      <span className="text-rust">
                        ✗ {amountMon} MON forfeited — deadline missed or PR not merged in time.
                      </span>
                    )}
                  </div>
                )}
                {stake.resolvedTxHash && (
                  <a
                    href={explorerTxUrl(stake.resolvedTxHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mb-3 block font-mono text-xs text-purple underline hover:text-purple/80"
                  >
                    View resolution on Monad Explorer ↗
                  </a>
                )}
                {!stake.resolved && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleCheck(stake.stakeId)}
                      disabled={busyId === stake.stakeId}
                      className="rounded-full bg-purple/15 px-3 py-1.5 text-xs font-medium text-purple hover:bg-purple/25 disabled:opacity-50"
                    >
                      Check Now
                    </button>
                    {isPastDeadline && (
                      <button
                        onClick={() => handleClaimExpired(stake.stakeId)}
                        disabled={busyId === stake.stakeId}
                        className="rounded-full bg-rust/15 px-3 py-1.5 text-xs font-medium text-rust hover:bg-rust/25 disabled:opacity-50"
                      >
                        Claim Expired
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
