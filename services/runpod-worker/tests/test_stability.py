from qwen_realtime.stability import StableTranscript


def test_rollback_tail_is_replaceable_but_committed_prefix_is_monotonic():
    state = StableTranscript(rollback_tokens=5)
    stable, unstable = state.update("ABCDEFGHIJ")
    assert (stable, unstable) == ("ABCDE", "FGHIJ")
    stable, unstable = state.update("ABCDEFGxyz")
    assert stable == "ABCDE"
    assert unstable == "FGxyz"
    assert state.rewrite_violations == 0


def test_rewrite_before_committed_prefix_is_counted():
    state = StableTranscript(rollback_tokens=2)
    state.update("abcdefgh")
    stable, unstable = state.update("abZZZZZZ")
    assert stable == "abcdef"
    assert unstable == "abZZZZZZ"
    assert state.rewrite_violations == 1


def test_final_is_authoritative():
    state = StableTranscript(rollback_tokens=5)
    state.update("partial output")
    assert state.update("final", final=True) == ("final", "")
