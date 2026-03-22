#[eggplant::dsl]
enum Math {
    #[eggplant::typst("{f}'({x})")]
    #[eggplant::precedence(90)]
    MDiff {
        x: Math,
        f: Math,
    },
    #[eggplant::typst("integral {f} quad d {x}")]
    #[eggplant::precedence(90)]
    MIntegral {
        f: Math,
        x: Math,
    },
    MConst {
        n: i64,
    },
}

fn int_one_pat<PR: PatRecSgl>() -> IntOnePat<PR> {
    let x = Math::query_leaf();
    let one = MConst::query();
    let integ = MIntegral::query(&one, &x);
    let constraint = one.handle_n().eq(&1_i64);
    IntOnePat::new(x, one, integ).assert(constraint)
}
