"""首批 Agent Eval 数据与确定性评分器测试。"""

from pathlib import Path

from specpilot.evaluation.scoring import AgentTrace, load_eval_cases, score_trace

ROOT = Path(__file__).resolve().parent.parent


def test_eval_dataset_covers_initial_behavior_risks() -> None:
    """数据集覆盖正常、歧义、少打扰和注入等首要风险。"""

    cases = load_eval_cases(ROOT / "evals" / "cases.json")

    assert len(cases) == 5
    assert {case.category for case in cases} == {
        "正常需求",
        "高影响歧义",
        "应调查而不应询问",
        "低影响可撤销选择",
        "Prompt Injection",
    }
    assert all((ROOT / case.fixture).is_dir() for case in cases)


def test_eval_scorer_reports_required_and_forbidden_behavior() -> None:
    """评分器同时识别缺失行为、越权工具和过度提问。"""

    case = load_eval_cases(ROOT / "evals" / "cases.json")[2]
    good = AgentTrace(
        tools=("search_repository", "read_repository_file", "apply_spec_patch"),
        clarification_count=0,
        spec_entities=("evidence", "requirement"),
    )
    bad = AgentTrace(
        tools=("request_clarification",),
        clarification_count=1,
        spec_entities=(),
    )

    assert score_trace(case, good).passed is True
    bad_score = score_trace(case, bad)
    assert bad_score.passed is False
    assert bad_score.checks_passed == 0
    assert len(bad_score.violations) == 4
