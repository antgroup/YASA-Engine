import re
from pathlib import Path

from yasa_mcp.util.codegraph_param_util import CodeGraphParamUtil


def test_build_method_fqn_candidates_supports_long_dot_form():
    candidates = CodeGraphParamUtil.build_method_fqn_candidates(
        "com.alipay.smartcampus.ModuleBootstrapApplication.main"
    )

    assert "com.alipay.smartcampus::ModuleBootstrapApplication::main" in candidates


def test_build_method_fqn_suffix_regex_preserves_all_boundaries():
    pattern = CodeGraphParamUtil.build_method_fqn_suffix_regex("foo.User.run")

    assert pattern == r"(?:^|\.|::)foo(?:\.|::)User::run$"
    assert re.search(pattern, "foo::User::run")
    assert re.search(pattern, "pkg.foo::User::run")
    assert re.search(pattern, "pkg::foo::User::run")
    assert not re.search(pattern, "pkg::notfoo::User::run")
    assert not re.search(pattern, "pkg::foo::NotUser::run")
    assert not re.search(pattern, "pkg::foo::User::run::nested")


def test_build_class_fqn_candidates_supports_dot_form():
    candidates = CodeGraphParamUtil.build_class_fqn_candidates(
        "com.alipay.smartcampus.ModuleBootstrapApplication"
    )

    assert "com.alipay.smartcampus::ModuleBootstrapApplication" in candidates


def test_build_class_fqn_candidates_supports_inner_class_from_first_uppercase_segment():
    assert CodeGraphParamUtil.build_class_fqn_candidates("com.example.Outer.Inner") == [
        "com.example::Outer::Inner"
    ]


def test_build_method_fqn_candidates_supports_inner_class_owner():
    assert CodeGraphParamUtil.build_method_fqn_candidates("com.example.Outer.Inner.run") == [
        "com.example::Outer::Inner::run"
    ]


def test_fqn_candidates_fall_back_to_last_lowercase_owner_segment():
    assert CodeGraphParamUtil.build_class_fqn_candidates("org.demo.user") == [
        "org.demo::user"
    ]
    assert CodeGraphParamUtil.build_method_fqn_candidates("org.demo.user.save") == [
        "org.demo::user::save"
    ]


def test_normalize_file_path_makes_absolute_path_relative(tmp_path):
    project = tmp_path / "project"
    file_path = project / "src" / "Main.java"

    assert CodeGraphParamUtil.normalize_file_path(project, str(file_path)) == "src/Main.java"


def test_adapt_fqn_regex_preserves_package_dots_and_converts_type_boundaries():
    assert (
        CodeGraphParamUtil.adapt_fqn_regex(r"com\.example\..*Controller\.run")
        == r"com.example::.*Controller::run"
    )


def test_build_method_signature_inserts_missing_method_name():
    signature = CodeGraphParamUtil.build_method_signature(
        "checkUsedByCourse",
        "SmartCampusResult<Boolean> (SmartCampusRequest<CheckUsedByCourseReq> request)",
    )

    assert signature == "SmartCampusResult<Boolean> checkUsedByCourse(SmartCampusRequest<CheckUsedByCourseReq> request)"


def test_build_method_signature_avoids_duplicate_method_name():
    assert CodeGraphParamUtil.build_method_signature("getPageNo", "int getPageNo()") == "int getPageNo()"
