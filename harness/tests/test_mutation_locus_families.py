"""Every approach family can state where it changes code: a proposal of a family with no
locus shape cannot be written at all."""
import typing

from evor.contracts import ApproachFamily, MutationLocus, MutationProposal  # noqa: F401


def test_every_family_has_a_locus_shape():
    families = set(typing.get_args(ApproachFamily))
    loci = {typing.get_args(m.model_fields["family"].annotation)[0] for m in typing.get_args(MutationLocus)}
    assert families - loci == set()


def test_other_locus_validates():
    from pydantic import TypeAdapter
    TypeAdapter(MutationLocus).validate_python({"family": "other", "path": "eval/"})
