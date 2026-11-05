// Zone layouts. One char per tile; rows are padded to the widest row.
//
// Town:    . grass  , grass h1  : grass h2  = path  - path h1  ~ water  T tree
//          H house (2x2)  F fountain  L lamp  P portal  @ spawn  d training dummy
// Dungeon: # wall  . floor  , floor h1  : floor h2  l lava  c crystal
//          t wall torch  m monster  P portal  @ spawn

export const ZONES = {
  // Animation lab (lab.html): open yard, a ring path, a two-step ramp, training dummies.
  arena: {
    name: 'Training Yard — Animation Lab',
    theme: 'town',
    rows: [
      'TTTTTTTTTTTTTTTTTT',
      'T................T',
      'T..d....d....d...T',
      'T................T',
      'T...L........L...T',
      'T.....======.....T',
      'T.....=....=..,,,T',
      'T..d..=.@..=..,:,T',
      'T.....=....=..,:,T',
      'T.....======..,,,T',
      'T................T',
      'T...L..d...d.L...T',
      'T................T',
      'TTTTTTTTTTTTTTTTTT',
    ],
  },
  town: {
    name: 'Aldenmere — Town Square',
    theme: 'town',
    portalTo: 'dungeon',
    rows: [
      'TTTTTTTTTTTTTTTTTTTTTTTTTT',
      'T........,,,,,,,.........T',
      'T..HH....,:::::,,...HH...T',
      'T..HH....,::t::,,...HH...T',
      'T........,,,,-,,,........T',
      'T....L.......=.......L...T',
      'T============F===========T',
      'T.......=....=....=......T',
      'T..HH...=....=....=..HH..T',
      'T..HH...=....=....=..HH..T',
      'T.......=....=....=......T',
      'T~~~....=....@....=......T',
      'T~~~~...===========......T',
      'T~~~~~.......=...........T',
      'T~~~~........=......t....T',
      'T~~~.........=...........T',
      'T............=....,,,,...T',
      'T..T.....L...=....,,P,...T',
      'T............=....,,,,...T',
      'TTTTTTTTTTTTTTTTTTTTTTTTTT',
    ],
  },
  dungeon: {
    name: 'Hollow Crypt — B1',
    theme: 'dungeon',
    portalTo: 'town',
    rows: [
      '########################',
      '#@.....#.......#.......#',
      '#......t.......#...m...#',
      '#..P...#...m...t.......#',
      '#......#.......#,,,,...#',
      '###.####.......#,::,...#',
      '#t.....###.#####,,,,...#',
      '#..........#.......#####',
      '#...c......#...l...#...#',
      '#..........t..lll..t...#',
      '#####...####...l.......#',
      '#.......#......m....m..#',
      '#..,,,..#..............#',
      '#..,:,..#....c.....,,,.#',
      '#..,,,..t..........,:,.#',
      '#...m...#..........,,,.#',
      '#.......#......m.......#',
      '########################',
    ],
  },
};
