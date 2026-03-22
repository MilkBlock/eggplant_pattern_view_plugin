#[eggplant::dsl]
enum SharedMath {
    #[eggplant::typst("{f}'({x})")]
    #[eggplant::precedence(90)]
    SharedDiff {
        x: SharedMath,
        f: SharedMath,
    },
    #[eggplant::typst("integral {f} quad d {x}")]
    #[eggplant::precedence(90)]
    SharedIntegral {
        f: SharedMath,
        x: SharedMath,
    },
    SharedConst {
        n: i64,
    },
}
